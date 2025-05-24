/**
 * Transaction Signer Lambda
 * 
 * This Lambda function is responsible for signing Ethereum transactions using
 * private keys stored in AWS Secrets Manager. It implements a robust system for
 * managing signing keys with the following features:
 * 
 * 1. Batch processing of SQS messages
 * 2. Address locking with retry mechanism for race conditions
 * 3. Secure key retrieval from Secrets Manager
 * 4. Transaction signing with ethers.js
 * 5. Signature storage in DynamoDB
 * 
 * The function uses a database-driven approach to manage signing addresses,
 * ensuring that each address is used in a round-robin fashion and properly
 * locked during use to prevent concurrent access.
 */

const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { ethers } = require('ethers');
const crypto = require('crypto');

// Initialize AWS clients with default configuration
// These clients will use the Lambda's execution role credentials
const secretsManager = new SecretsManagerClient();
const dynamoDB = new DynamoDBClient();
const s3 = new S3Client();

// Initialize PostgreSQL client for address management
// The connection details are provided via environment variables
const pgClient = new Client({
  host: process.env.AURORA_CLUSTER_ENDPOINT,
  port: process.env.AURORA_CLUSTER_PORT,
  database: 'postgres',
  user: 'admin',
  password: process.env.AURORA_SECRET_ARN,
});

/**
 * Safely logs information without exposing sensitive data
 * 
 * @param {string} level - Log level (info, warn, error)
 * @param {string} message - Log message
 * @param {Object} [data] - Optional data to log (sensitive fields will be redacted)
 * @param {string[]} [sensitiveFields] - List of fields to redact
 */
function safeLog(level, message, data = {}, sensitiveFields = ['privateKey', 'signature', 'password', 'secret']) {
  const sanitizedData = { ...data };
  
  // Redact sensitive fields
  sensitiveFields.forEach(field => {
    if (field in sanitizedData) {
      sanitizedData[field] = '[REDACTED]';
    }
  });
  
  // Log with sanitized data
  console[level](message, Object.keys(sanitizedData).length ? sanitizedData : '');
}

/**
 * Retrieves a wallet instance for a given Ethereum address with retry logic
 * 
 * @param {string} address - The Ethereum address to get the wallet for
 * @param {number} retries - Current retry attempt (default: 0)
 * @returns {Promise<ethers.Wallet>} A wallet instance with the private key
 * 
 * This function:
 * 1. Constructs the secret ID using the address
 * 2. Retrieves the secret from Secrets Manager with retry logic
 * 3. Creates an ethers.js wallet instance with the private key
 * 
 * Retry logic:
 * - Uses exponential backoff between retries
 * - Maximum of 3 retries by default
 * - Only retries on specific transient errors
 */
async function getWallet(address, retries = 0) {
  const maxRetries = parseInt(process.env.MAX_RETRIES || '3');
  
  try {
    const command = new GetSecretValueCommand({
      SecretId: `${process.env.AURORA_SECRET_ARN}:${address}`,
    });
    const response = await secretsManager.send(command);
    const secret = JSON.parse(response.SecretString);
    safeLog('info', 'Retrieved wallet for address', { address });
    return new ethers.Wallet(secret.privateKey);
  } catch (error) {
    // Check if error is retryable
    const isRetryable = error.name === 'ThrottlingException' || 
                       error.name === 'InternalServiceErrorException' ||
                       error.name === 'ServiceUnavailableException';
    
    if (isRetryable && retries < maxRetries) {
      // Implement exponential backoff for retries
      // This helps prevent overwhelming the service
      const delay = Math.pow(2, retries) * 100;
      safeLog('warn', 'Retryable error getting wallet', { 
        address,
        error: error.name,
        retryAttempt: retries + 1,
        maxRetries,
        delay
      });
      await new Promise(resolve => setTimeout(resolve, delay));
      return getWallet(address, retries + 1);
    }
    
    // If we've exhausted retries or it's not a retryable error, throw
    safeLog('error', 'Failed to get wallet', { 
      address,
      error: error.name,
      message: error.message
    });
    throw error;
  }
}

/**
 * Calculates a deterministic hash for a transaction
 * 
 * @param {Object} transaction - The Ethereum transaction object
 * @returns {string} A hex-encoded SHA-256 hash of the transaction
 * 
 * This hash is used as the primary key in DynamoDB to ensure
 * uniqueness and enable efficient lookups of signatures.
 */
function calculateTransactionHash(transaction) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(transaction))
    .digest('hex');
}

/**
 * Gets and locks an available signing address
 * 
 * @param {number} retries - Current retry attempt (default: 0)
 * @returns {Promise<Object>} Object containing addressId and address
 * 
 * This function implements a robust locking mechanism:
 * 1. Uses PostgreSQL transactions for atomic operations
 * 2. Implements FOR UPDATE SKIP LOCKED for concurrent access
 * 3. Uses exponential backoff for retries
 * 4. Updates last_used_at timestamp for round-robin selection
 */
async function getAndLockAddress(retries = 0) {
  const maxRetries = parseInt(process.env.MAX_RETRIES || '3');
  
  try {
    // Start transaction for atomic operation
    await pgClient.query('BEGIN');
    
    // Get and lock the least recently used address
    // FOR UPDATE SKIP LOCKED ensures we don't block on locked rows
    const result = await pgClient.query(`
      UPDATE addresses 
      SET last_used_at = NOW() 
      WHERE id = (
        SELECT id 
        FROM addresses 
        WHERE last_used_at IS NOT NULL 
        ORDER BY last_used_at ASC 
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, address
    `);
    
    if (result.rows.length === 0) {
      await pgClient.query('ROLLBACK');
      throw new Error('No available addresses');
    }
    
    await pgClient.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await pgClient.query('ROLLBACK');
    
    if (retries < maxRetries) {
      // Implement exponential backoff for retries
      // This helps prevent thundering herd problems
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, retries) * 100));
      return getAndLockAddress(retries + 1);
    }
    
    throw error;
  }
}

/**
 * Releases the lock on a signing address
 * 
 * @param {number} addressId - The ID of the address to unlock
 * 
 * This function:
 * 1. Updates the last_used_at timestamp
 * 2. Uses a transaction to ensure atomicity
 * 3. Handles rollback in case of errors
 */
async function releaseAddressLock(addressId) {
  try {
    await pgClient.query('BEGIN');
    await pgClient.query('UPDATE addresses SET last_used_at = NOW() WHERE id = $1', [addressId]);
    await pgClient.query('COMMIT');
  } catch (error) {
    await pgClient.query('ROLLBACK');
    throw error;
  }
}

/**
 * Stores a signature in DynamoDB
 * 
 * @param {string} transactionHash - The hash of the signed transaction
 * @param {string} address - The Ethereum address used for signing
 * @param {string} s3Path - The S3 path of the original transaction
 * @param {string} signature - The generated signature
 * 
 * This function:
 * 1. Uses the transaction hash as the primary key
 * 2. Stores additional metadata for auditing and tracking
 * 3. Uses AWS SDK v3 for DynamoDB operations
 */
async function storeSignature(transactionHash, address, s3Path, signature) {
  const params = {
    TableName: process.env.SIGNATURES_TABLE,
    Item: marshall({
      PK: transactionHash,
      address: address,
      s3_path: s3Path,
      signature: signature,
      signed_at: new Date().toISOString()
    })
  };
  
  await dynamoDB.send(new PutItemCommand(params));
}

/**
 * Main Lambda handler function
 * 
 * @param {Object} event - The SQS event containing records to process
 * 
 * This function implements the main processing loop:
 * 1. Processes each record in the batch
 * 2. Gets and locks an available address
 * 3. Retrieves the signing key
 * 4. Signs the transaction
 * 5. Stores the signature
 * 6. Releases the address lock
 * 
 * Error handling ensures:
 * - Address locks are always released
 * - Database connections are properly closed
 * - Individual record failures don't affect the batch
 */
exports.handler = async (event) => {
  // Connect to PostgreSQL
  await pgClient.connect();
  
  try {
    // Process each record in the batch
    for (const record of event.Records) {
      try {
        // Parse the SQS message and extract S3 path
        const message = JSON.parse(record.body);
        const s3Event = JSON.parse(message.Records[0].s3);
        const s3Path = s3Event.object.key;
        
        safeLog('info', 'Processing record', { s3Path });
        
        // Get and lock an available address
        const { id: addressId, address } = await getAndLockAddress();
        
        try {
          // Get the wallet for signing
          const wallet = await getWallet(address);
          
          // Read the transaction from S3 using SDK v3
          const getObjectCommand = new GetObjectCommand({
            Bucket: process.env.DATA_LAKE_BUCKET,
            Key: s3Path
          });
          const s3Response = await s3.send(getObjectCommand);
          
          // Convert the readable stream to string
          const transaction = JSON.parse(await streamToString(s3Response.Body));
          
          // Sign the transaction using ethers.js
          const signature = await wallet.signTransaction(transaction);
          
          // Calculate transaction hash for DynamoDB
          const transactionHash = calculateTransactionHash(transaction);
          
          safeLog('info', 'Transaction signed successfully', {
            transactionHash,
            address,
            s3Path
          });
          
          // Store signature in DynamoDB
          await storeSignature(transactionHash, address, s3Path, signature);
          
          // Release the address lock
          await releaseAddressLock(addressId);
        } catch (error) {
          // Release the address lock in case of error
          await releaseAddressLock(addressId);
          safeLog('error', 'Error processing transaction', {
            s3Path,
            address,
            error: error.name,
            message: error.message
          });
          throw error;
        }
      } catch (error) {
        safeLog('error', 'Error processing record', {
          error: error.name,
          message: error.message
        });
        // Continue processing other records even if one fails
      }
    }
  } finally {
    // Always close the PostgreSQL connection
    await pgClient.end();
  }
};

/**
 * Helper function to convert a readable stream to string
 * 
 * @param {ReadableStream} stream - The readable stream to convert
 * @returns {Promise<string>} The stream contents as a string
 */
async function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
} 
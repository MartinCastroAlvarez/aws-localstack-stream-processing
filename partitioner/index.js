/**
 * Firehose Partitioning Lambda
 * 
 * This Lambda function is responsible for determining which partition each record
 * should be written to in S3. It uses a consistent hashing strategy to ensure
 * even distribution of records across partitions while maintaining deterministic
 * routing for the same record ID.
 * 
 * The function is triggered by Firehose for each batch of records and must return
 * a response that includes partition metadata for each record.
 */

// Simple hash function (djb2)
// This is a fast, non-cryptographic hash function that provides good distribution
// while being computationally efficient. It's suitable for partitioning as we
// don't need cryptographic properties, just even distribution.
function hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return Math.abs(hash);
}

/**
 * Main Lambda handler function
 * 
 * @param {Object} event - The event object from Firehose containing records to process
 * @returns {Object} Response object with processed records and their partition assignments
 * 
 * The function processes each record in the batch:
 * 1. Decodes the base64-encoded data
 * 2. Extracts or generates a record ID
 * 3. Calculates a partition number using consistent hashing
 * 4. Returns the record with partition metadata
 * 
 * Error handling ensures that if a record can't be processed, it's marked as failed
 * rather than causing the entire batch to fail.
 */
exports.handler = async (event) => {
  return {
    records: event.records.map(rec => {
      try {
        // Parse the base64 encoded data
        // Firehose encodes record data in base64 to handle binary content
        const payload = JSON.parse(Buffer.from(rec.data, 'base64').toString());
        
        // Use record ID or generate a hash from the payload
        // This ensures consistent partitioning for the same record
        // If no ID exists, we hash the entire payload as a fallback
        const recordId = payload.id || JSON.stringify(payload);
        
        // Calculate partition number using modulo operation
        // This ensures even distribution across available partitions
        // The number of partitions is configurable via environment variable
        const partitionNum = hash(recordId) % process.env.PARTITION;
        const partition = `partition_${partitionNum}`;

        // Return the record with partition metadata
        // Firehose uses this metadata to determine the S3 prefix
        return {
          recordId: rec.recordId,
          result: 'Ok',
          data: rec.data,
          metadata: {
            partitionKeys: {
              bucketPartition: partition
            }
          }
        };
      } catch (error) {
        // If there's an error processing the record, mark it as failed
        // This allows Firehose to handle the error appropriately
        // Other records in the batch will still be processed
        return {
          recordId: rec.recordId,
          result: 'ProcessingFailed',
          data: rec.data
        };
      }
    })
  };
}; 
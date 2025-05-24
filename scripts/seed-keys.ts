import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { generateKeyPair } from 'crypto';
import { promisify } from 'util';

const generateKeyPairAsync = promisify(generateKeyPair);

interface KeyPair {
  publicKey: string;
  privateKey: string;
  address: string;
  ethPrivateKey: string;
}

async function generateRSAKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  return { publicKey, privateKey };
}

async function main() {
  const numKeys = parseInt(process.argv[2]);

  if (isNaN(numKeys) || numKeys <= 0) {
    console.error('Error: Please provide a valid number of keys to generate');
    console.error('Usage: yarn seed:keys <number_of_keys>');
    process.exit(1);
  }

  const outputDir = path.join(process.cwd(), 'keys');
  
  // Clear the keys directory if it exists
  if (fs.existsSync(outputDir)) {
    console.log('Clearing existing keys directory...');
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  
  // Create fresh keys directory
  fs.mkdirSync(outputDir, { recursive: true });

  const keyPairs: KeyPair[] = [];

  console.log(`Generating ${numKeys} RSA + Ethereum key pairs...`);

  for (let i = 0; i < numKeys; i++) {
    const { publicKey, privateKey } = await generateRSAKeyPair();
    const wallet = ethers.Wallet.createRandom();

    keyPairs.push({
      address: wallet.address,
      publicKey,
      privateKey,
      ethPrivateKey: wallet.privateKey,
    });
  }

  // Split keys into chunks of 1000
  const keysPerFile = 1000;
  const numFiles = Math.ceil(keyPairs.length / keysPerFile);

  for (let i = 0; i < numFiles; i++) {
    const start = i * keysPerFile;
    const end = Math.min(start + keysPerFile, keyPairs.length);
    const chunk = keyPairs.slice(start, end);
    
    const fileName = `keys-${i + 1}.json`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(chunk, null, 2));
    console.log(`Generated file ${fileName} with ${chunk.length} keys`);
  }

  console.log(`\nGenerated ${keyPairs.length} key pairs`);
  console.log(`Keys are split into ${numFiles} files in the 'keys' directory`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

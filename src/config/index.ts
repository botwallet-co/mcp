export {
  configDir,
  configPath,
  seedsDir,
  seedFileValue,
  configExists,
  getWallet,
  listWallets,
  addWallet,
  setDefaultWallet,
  generateLocalName,
  resolveWallet,
  resolveBaseUrl,
  envOverrideNote,
  type AddWalletResult,
} from './config.js';

export {
  seedFilePath,
  seedExists,
  saveSeed,
  removeNewSeed,
  savePendingSeed,
  loadSeed,
} from './seeds.js';

export {
  writeBwlt,
  readBwlt,
  encryptPayload,
  decryptPayload,
  encodeBwltPayload,
  parseBwltPayload,
  BwltPayloadError,
  type BwltPayload,
} from './bwlt.js';

export {
  generateBackupCode,
  writeBackupNonce,
  checkBackupCode,
  type BackupCodeCheck,
} from './backup-nonce.js';

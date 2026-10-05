export {
  configDir,
  configPath,
  seedsDir,
  seedFileValue,
  configExists,
  loadConfig,
  saveConfig,
  getWallet,
  getDefaultWallet,
  listWallets,
  addWallet,
  setDefaultWallet,
  sanitizeWalletName,
  generateLocalName,
  resolveWallet,
  resolveBaseUrl,
  envOverrideNote,
  type WalletEntry,
  type BotWalletLocalConfig,
  type AddWalletOptions,
  type AddWalletResult,
  type ResolvedWallet,
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
  BWLT_PAYLOAD_VERSION,
  type BwltContents,
  type BwltPayload,
} from './bwlt.js';

export {
  backupNoncePath,
  generateBackupCode,
  writeBackupNonce,
  checkBackupCode,
  BACKUP_CODE_TTL_MS,
  type BackupCodeCheck,
} from './backup-nonce.js';

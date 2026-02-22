import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const ALGORITHM = 'aes-256-gcm';
// A CHAVE DEVE SER IDÊNTICA À DO PROJETO PRINCIPAL
const ENCRYPT_KEY_STRING = process.env.ENCRYPT_KEY || 'default_secret_key_32_bytes_long';
const ENCRYPT_KEY = crypto.scryptSync(ENCRYPT_KEY_STRING, 'salt', 32);

export function decrypt(encryptedData: string): string {
    const [ivHex, authTagHex, encryptedText] = encryptedData.split(':');

    if (!ivHex || !authTagHex || !encryptedText) {
        throw new Error('Formato cifrado corrompido');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPT_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

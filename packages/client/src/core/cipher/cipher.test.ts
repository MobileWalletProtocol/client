import { unzlibSync, zlibSync } from 'fflate';

import {
  decrypt,
  decryptContent,
  deriveSharedSecret,
  encrypt,
  encryptContent,
  exportKeyToHexString,
  generateKeyPair,
  importKeyFromHexString,
} from './cipher';
import { EncryptedData, RPCRequest, RPCResponse } from ':core/message';
import { hexStringToUint8Array, uint8ArrayToHex } from ':core/type/util';

async function webEncrypt(sharedSecret: CryptoKey, plainText: string): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plainTextBytes = new TextEncoder().encode(plainText);
  const compressedBytes = zlibSync(plainTextBytes);
  const cipherText = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedSecret,
    compressedBytes
  );

  return { iv: new Uint8Array(iv), cipherText: new Uint8Array(cipherText) };
}

async function webDecrypt(
  sharedSecret: CryptoKey,
  { iv, cipherText }: EncryptedData
): Promise<string> {
  const compressedBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    sharedSecret,
    cipherText
  );
  const decompressedBytes = unzlibSync(Buffer.from(compressedBytes));
  return new TextDecoder().decode(decompressedBytes);
}

function getFormat(keyType: 'public' | 'private') {
  switch (keyType) {
    case 'public':
      return 'spki';
    case 'private':
      return 'pkcs8';
  }
}

async function webExportKeyToHexString(
  type: 'public' | 'private',
  key: CryptoKey
): Promise<string> {
  const format = getFormat(type);
  const exported = await crypto.subtle.exportKey(format, key);
  return uint8ArrayToHex(new Uint8Array(exported));
}

async function webImportKeyFromHexString(
  type: 'public' | 'private',
  hexString: string
): Promise<CryptoKey> {
  const format = getFormat(type);
  const arrayBuffer = hexStringToUint8Array(hexString).buffer;
  return await crypto.subtle.importKey(
    format,
    arrayBuffer,
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    type === 'private' ? ['deriveKey'] : []
  );
}

describe('cipher', () => {
  let webPrivateKey: CryptoKey;
  let webPublicKey: CryptoKey;

  beforeAll(async () => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      ['deriveKey']
    );
    webPrivateKey = keyPair.privateKey;
    webPublicKey = keyPair.publicKey;
  });

  it('exporting public key works just as web counterpart', async () => {
    const webRawPublicKey = await crypto.subtle.exportKey('raw', webPublicKey);
    const webPublicKeyInHex = await webExportKeyToHexString('public', webPublicKey);
    const nativeExportedWebRawPublicKeyInHex = await exportKeyToHexString('public', {
      type: 'public',
      algorithm: {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      extractable: true,
      usages: [],
      _key: new Uint8Array(webRawPublicKey),
    });

    expect(nativeExportedWebRawPublicKeyInHex).toBe(webPublicKeyInHex);
  });

  it('importing public key works just as web counterpart', async () => {
    const webRawPublicKey = await crypto.subtle.exportKey('raw', webPublicKey);
    const nativeExportedWebRawPublicKey = await exportKeyToHexString('public', {
      type: 'public',
      algorithm: {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      extractable: true,
      usages: [],
      _key: new Uint8Array(webRawPublicKey),
    });

    const webPublicKeyInHex = await webExportKeyToHexString('public', webPublicKey);

    expect(nativeExportedWebRawPublicKey).toBe(webPublicKeyInHex);
  });

  it('importing exported public key should be the same as the original key', async () => {
    const nativeKeyPair = await generateKeyPair();
    const nativePublicKey = nativeKeyPair.publicKey;
    const nativePublicKeyInHex = await exportKeyToHexString('public', nativePublicKey);

    const recoveredNativePublicKey = await importKeyFromHexString('public', nativePublicKeyInHex);

    expect(nativePublicKey._key).toEqual(recoveredNativePublicKey._key);
  });

  it('importing exported private key should be the same as the original key', async () => {
    const nativeKeyPair = await generateKeyPair();
    const nativePrivateKey = nativeKeyPair.privateKey;
    const nativePrivateKeyInHex = await exportKeyToHexString('private', nativePrivateKey);

    const recoveredNativePrivateKey = await importKeyFromHexString(
      'private',
      nativePrivateKeyInHex
    );

    expect(nativePrivateKey._key).toEqual(recoveredNativePrivateKey._key);
  });

  it('importing wrong private key will throw', async () => {
    const nativeKeyPair = await generateKeyPair();
    const nativePublicKey = nativeKeyPair.publicKey;
    const nativePublicKeyInHex = await exportKeyToHexString('public', nativePublicKey);

    await expect(importKeyFromHexString('private', nativePublicKeyInHex)).rejects.toThrowError(
      'Invalid private key'
    );
  });

  it('deriving shared secret works just as web counterpart', async () => {
    const nativeKeyPair = await generateKeyPair();
    const ownPrivateKey = nativeKeyPair.privateKey;
    const ownPublicKey = nativeKeyPair.publicKey;
    const ownPublicKeyInHex = await exportKeyToHexString('public', ownPublicKey);

    const peerPrivateKey = webPrivateKey;
    const peerPublicKey = webPublicKey;
    const peerPublicKeyInHex = await webExportKeyToHexString('public', peerPublicKey);

    // get shared secret in web
    const webRecoveredOwnPublicKey = await webImportKeyFromHexString('public', ownPublicKeyInHex);
    const webSharedSecret = await crypto.subtle.deriveKey(
      {
        name: 'ECDH',
        public: webRecoveredOwnPublicKey,
      },
      peerPrivateKey,
      {
        name: 'AES-GCM',
        length: 256,
      },
      true,
      ['encrypt', 'decrypt']
    );
    const webSharedSecretInHex = await crypto.subtle.exportKey('raw', webSharedSecret);

    // get shared secret in native
    const recoveredPeerPublicKey = await importKeyFromHexString('public', peerPublicKeyInHex);
    const nativeSharedSecret = await deriveSharedSecret(ownPrivateKey, recoveredPeerPublicKey);

    expect(nativeSharedSecret._key).toEqual(new Uint8Array(webSharedSecretInHex));
  });

  it('encrypting in web and decrypting in native', async () => {
    const nativeKeyPair = await generateKeyPair();
    const ownPrivateKey = nativeKeyPair.privateKey;
    const ownPublicKey = nativeKeyPair.publicKey;
    const ownPublicKeyInHex = await exportKeyToHexString('public', ownPublicKey);

    const peerPrivateKey = webPrivateKey;
    const peerPublicKey = webPublicKey;
    const peerPublicKeyInHex = await webExportKeyToHexString('public', peerPublicKey);

    // get shared secret in web
    const webRecoveredOwnPublicKey = await webImportKeyFromHexString('public', ownPublicKeyInHex);
    const webSharedSecret = await crypto.subtle.deriveKey(
      {
        name: 'ECDH',
        public: webRecoveredOwnPublicKey,
      },
      peerPrivateKey,
      {
        name: 'AES-GCM',
        length: 256,
      },
      true,
      ['encrypt', 'decrypt']
    );

    // get shared secret in native
    const recoveredPeerPublicKey = await importKeyFromHexString('public', peerPublicKeyInHex);
    const nativeSharedSecret = await deriveSharedSecret(ownPrivateKey, recoveredPeerPublicKey);

    // encrypt in web
    const plainText = 'hello world';
    const encryptedData = await webEncrypt(webSharedSecret, plainText);

    // decrypt in native
    const receivedEncryptionData = {
      iv: new Uint8Array(encryptedData.iv),
      cipherText: new Uint8Array(encryptedData.cipherText),
    };

    const decryptedText = await decrypt(nativeSharedSecret, receivedEncryptionData);

    expect(decryptedText).toBe(plainText);
  });

  it('encrypting in native and decrypting in web', async () => {
    const nativeKeyPair = await generateKeyPair();
    const ownPrivateKey = nativeKeyPair.privateKey;
    const ownPublicKey = nativeKeyPair.publicKey;
    const ownPublicKeyInHex = await exportKeyToHexString('public', ownPublicKey);

    const peerPrivateKey = webPrivateKey;
    const peerPublicKey = webPublicKey;
    const peerPublicKeyInHex = await webExportKeyToHexString('public', peerPublicKey);

    // get shared secret in web
    const webRecoveredOwnPublicKey = await webImportKeyFromHexString('public', ownPublicKeyInHex);
    const webSharedSecret = await crypto.subtle.deriveKey(
      {
        name: 'ECDH',
        public: webRecoveredOwnPublicKey,
      },
      peerPrivateKey,
      {
        name: 'AES-GCM',
        length: 256,
      },
      true,
      ['encrypt', 'decrypt']
    );

    // get shared secret in native
    const recoveredPeerPublicKey = await importKeyFromHexString('public', peerPublicKeyInHex);
    const nativeSharedSecret = await deriveSharedSecret(ownPrivateKey, recoveredPeerPublicKey);

    // encrypt in native
    const plainText = 'hello world';
    const encryptedData = await encrypt(nativeSharedSecret, plainText);

    // decrypt in web
    const receivedEncryptionData = {
      iv: new Uint8Array(encryptedData.iv),
      cipherText: new Uint8Array(encryptedData.cipherText),
    };

    const decryptedText = await webDecrypt(webSharedSecret, receivedEncryptionData);

    expect(decryptedText).toBe(plainText);
  });

  describe('Encryption and Decryption Tests', () => {
    let sharedSecret: {
      type: 'private' | 'public' | 'secret';
      algorithm: {
        name: string;
        namedCurve?: string;
        length?: number;
      };
      extractable: boolean;
      usages: string[];
      _key: Uint8Array;
    };

    beforeAll(async () => {
      const aliceKeyPair = await generateKeyPair();
      const bobKeyPair = await generateKeyPair();
      sharedSecret = await deriveSharedSecret(aliceKeyPair.privateKey, bobKeyPair.publicKey);
    });

    it('should encrypt and decrypt RPCRequest correctly', async () => {
      const request: RPCRequest = {
        action: {
          method: 'personal_sign',
          params: { foo: 'bar', baz: 42 },
        },
        chainId: 1,
      };
      const encrypted = await encryptContent(request, sharedSecret);
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('cipherText');

      const decrypted = await decryptContent<RPCRequest>(encrypted, sharedSecret);
      expect(decrypted).toEqual(request);
    });

    it('should encrypt and decrypt RPCResponse correctly', async () => {
      const response: RPCResponse = {
        result: {
          value: 'test value',
        },
      };

      const encrypted = await encryptContent(response, sharedSecret);
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('cipherText');

      const decrypted = await decryptContent<RPCResponse>(encrypted, sharedSecret);
      expect(decrypted).toEqual(response);
    });

    it('should handle RPCResponse containing Error correctly', async () => {
      const errorResponse: RPCResponse = {
        result: {
          error: {
            code: 789,
            message: 'Test error message',
          },
        },
      };

      const encrypted = await encryptContent(errorResponse, sharedSecret);
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('cipherText');

      const decrypted = await decryptContent<RPCResponse>(encrypted, sharedSecret);
      expect(decrypted).toEqual(errorResponse);
    });

    it('should throw an error when decrypting invalid data', async () => {
      const invalidEncryptedData = {
        iv: new Uint8Array([1, 2, 3]),
        cipherText: new Uint8Array([4, 5, 6]),
      };

      await expect(decryptContent(invalidEncryptedData, sharedSecret)).rejects.toThrow();
    });
  });
});

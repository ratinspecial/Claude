/*
 * rs-crypt.js — Ratin Special preset encryption helper (AES-256-GCM)
 * ------------------------------------------------------------------
 * Used in two places with the SAME code:
 *   1) The offline tool  tools/encrypt-presets.js  (run once by you to lock all .rspk)
 *   2) The panel at runtime (main.js) to DECRYPT a preset just before After Effects
 *      applies it.
 *
 * SECURITY NOTE — this file is not secret and being readable changes nothing.
 * The security of AES does NOT depend on hiding the algorithm; it depends ONLY
 * on keeping the 32-byte KEY secret. The key is NEVER stored in this repo or on
 * the customer's disk — the panel fetches it from your Worker at launch (only
 * after a valid, ticketed licence) and keeps it in memory. Block the Worker or
 * patch the licence check out and you simply never get the key, so the locked
 * presets stay unreadable.
 *
 * Encrypted file layout (all binary, concatenated):
 *   magic   5 bytes  = "RSPK1"
 *   version 1 byte   = 0x01
 *   iv      12 bytes = random GCM nonce (unique per file)
 *   tag     16 bytes = GCM auth tag
 *   data    N bytes  = AES-256-GCM ciphertext of the original .ffx bytes
 */
"use strict";

var crypto = require("crypto");

var MAGIC = Buffer.from("RSPK1", "ascii"); // 5 bytes
var VERSION = 0x01;
var IV_LEN = 12;
var TAG_LEN = 16;
var HEADER_LEN = MAGIC.length + 1 + IV_LEN + TAG_LEN; // 5+1+12+16 = 34

// Accept the key as a 32-byte Buffer, or a 64-char hex / base64 string.
function rsNormalizeKey(key) {
    if (Buffer.isBuffer(key)) {
        if (key.length !== 32) throw new Error("Key must be 32 bytes, got " + key.length);
        return key;
    }
    var s = String(key || "").trim();
    var buf;
    if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, "hex");
    else buf = Buffer.from(s, "base64");
    if (buf.length !== 32) throw new Error("Key must decode to 32 bytes (got " + buf.length + ")");
    return buf;
}

function rsGenerateKey() {
    return crypto.randomBytes(32); // use .toString("hex") to store/share it
}

// Is this buffer already one of our encrypted blobs?
function rsIsEncrypted(buf) {
    return Buffer.isBuffer(buf) && buf.length >= HEADER_LEN &&
        buf.slice(0, MAGIC.length).equals(MAGIC);
}

// plaintext Buffer -> encrypted Buffer
function rsEncrypt(plainBuf, key) {
    var k = rsNormalizeKey(key);
    if (!Buffer.isBuffer(plainBuf)) plainBuf = Buffer.from(plainBuf);
    var iv = crypto.randomBytes(IV_LEN);
    var cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
    var enc = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
    var tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, tag, enc]);
}

// encrypted Buffer -> plaintext Buffer (throws if wrong key or tampered)
function rsDecrypt(blob, key) {
    var k = rsNormalizeKey(key);
    if (!rsIsEncrypted(blob)) throw new Error("Not an RSPK1 encrypted file");
    var p = MAGIC.length;
    var ver = blob[p]; p += 1;
    if (ver !== VERSION) throw new Error("Unsupported RSPK version " + ver);
    var iv = blob.slice(p, p + IV_LEN); p += IV_LEN;
    var tag = blob.slice(p, p + TAG_LEN); p += TAG_LEN;
    var data = blob.slice(p);
    var decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

module.exports = {
    MAGIC: MAGIC,
    HEADER_LEN: HEADER_LEN,
    generateKey: rsGenerateKey,
    normalizeKey: rsNormalizeKey,
    isEncrypted: rsIsEncrypted,
    encrypt: rsEncrypt,
    decrypt: rsDecrypt
};

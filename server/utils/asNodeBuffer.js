'use strict';

/**
 * html-to-docx (JSZip) returns a Blob on Node 18+ because Blob is global.
 * fs.writeFileSync cannot persist a Blob. Coerce anything we got from a
 * DOCX/PDF library into a Node Buffer.
 */
async function asNodeBuffer(data) {
    if (data == null) return data;
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return Buffer.from(await data.arrayBuffer());
    }
    if (data && typeof data.arrayBuffer === 'function') {
        return Buffer.from(await data.arrayBuffer());
    }
    throw new Error(
        `Expected a Buffer for file write, got ${Object.prototype.toString.call(data)}`
    );
}

module.exports = { asNodeBuffer };

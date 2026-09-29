/**
 * Image transfer over the existing chat DataChannel — chunked JSON frames.
 *
 * Protocol (all fields short, chunks are plain base64 text so no binary
 * DataChannel support is required):
 *   { type:'img-start', id, from, mime, size, total, batch? }
 *   { type:'img-chunk', id, i, d }        (i = 0..total-1)
 *   { type:'img-end',   id, from, batch? }
 *
 * The sending side compresses first: tiny originals and GIFs pass through
 * untouched (animation/transparency preserved), everything else is re-encoded
 * to JPEG with decreasing size/quality until it fits the budget.
 */

const CHUNK_CHARS = 12 * 1024; // base64 chars per frame — cross-browser safe
const MAX_FILE_BYTES = 8 * 1024 * 1024; // raw file picked/pasted by the user
const MAX_TRANSFER_CHARS = 1600 * 1024; // receiver cap (~1.15 MB decoded)
const SAFE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const DATA_URL_RE = /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * Read a picked/pasted image file into a sendable data URL.
 * @returns {Promise<{mime:string, dataUrl:string}>}
 * @throws {Error} 'not-image' | 'too-large' | 'read-failed' | 'compress-failed'
 */
export async function fileToImageMessage(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) throw new Error('not-image');
    if (file.size > MAX_FILE_BYTES) throw new Error('too-large');

    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('read-failed'));
        reader.readAsDataURL(file);
    });
    if (!DATA_URL_RE.test(dataUrl)) throw new Error('not-image');

    // keep GIFs (canvas would kill the animation) and small originals as-is
    if (file.type === 'image/gif' || dataUrl.length <= 600 * 1024) {
        if (dataUrl.length <= MAX_TRANSFER_CHARS) return { mime: file.type, dataUrl };
    }

    const compressed = await compressToJpeg(dataUrl).catch(() => null);
    if (!compressed) throw new Error('compress-failed');
    if (compressed.length >= dataUrl.length && dataUrl.length <= MAX_TRANSFER_CHARS) {
        return { mime: file.type, dataUrl }; // compression didn't help
    }
    if (compressed.length > MAX_TRANSFER_CHARS) throw new Error('too-large');
    return { mime: 'image/jpeg', dataUrl: compressed };
}

async function compressToJpeg(dataUrl) {
    const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = dataUrl;
    });
    let last = '';
    for (const maxDim of [1600, 1200, 900]) {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        for (const quality of [0.8, 0.62, 0.5]) {
            last = canvas.toDataURL('image/jpeg', quality);
            if (last.length <= 900 * 1024) return last;
        }
    }
    return last; // best effort even if over budget — sender re-checks the cap
}

/**
 * Split a data URL into protocol frames and push them through `send`
 * (typically Mesh.sendChat, one broadcast per frame). An optional `batch`
 * id ties the transfer to a merged text+images bubble on the receiver.
 */
export function sendImageData({ send, from, mime, dataUrl, batch = '' }) {
    const id = crypto.randomUUID();
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const total = Math.ceil(base64.length / CHUNK_CHARS);
    const tag = typeof batch === 'string' && batch.length <= 64 ? batch : '';
    send({ type: 'img-start', id, from, mime, size: base64.length, total, batch: tag });
    for (let i = 0; i < total; i++) {
        send({ type: 'img-chunk', id, i, d: base64.substr(i * CHUNK_CHARS, CHUNK_CHARS) });
    }
    send({ type: 'img-end', id, from, batch: tag });
}

/**
 * Reassemble incoming frames. Everything is validated before it touches the
 * DOM: mime whitelist, size caps, chunk bounds — a malicious peer can at worst
 * waste bandwidth up to the cap, never inject markup.
 *
 * @param {object} options
 * @param {function({from:string, dataUrl:string}):void} options.onDone
 * @param {function(reason:string):void} [options.onFail]
 */
export function createImageReceiver({ onDone, onFail }) {
    /** id -> { from, mime, size, total, parts, got, timer } */
    const incoming = new Map();

    function fail(id, reason) {
        const entry = incoming.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        incoming.delete(id);
        if (onFail) onFail(reason, entry.batch);
    }

    return function handleImageFrame(msg) {
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'img-start') {
            const { id, from, mime, size, total } = msg;
            if (typeof id !== 'string' || id.length > 64 || incoming.has(id)) return;
            if (!SAFE_MIMES.includes(mime)) return fail(id, 'bad-mime');
            if (typeof size !== 'number' || size <= 0 || size > MAX_TRANSFER_CHARS) return fail(id, 'bad-size');
            if (typeof total !== 'number' || total < 1 || total > 200) return fail(id, 'bad-total');
            incoming.set(id, {
                from: String(from || '').slice(0, 24),
                mime,
                size,
                total,
                batch: typeof msg.batch === 'string' && msg.batch.length <= 64 ? msg.batch : '',
                parts: new Array(total),
                got: 0,
                timer: setTimeout(() => fail(id, 'timeout'), 20000),
            });
            return;
        }

        const entry = incoming.get(msg.id);
        if (!entry) return;

        if (msg.type === 'img-chunk') {
            const { i, d } = msg;
            if (typeof i !== 'number' || i < 0 || i >= entry.total) return fail(msg.id, 'bad-chunk');
            if (typeof d !== 'string' || !d.length || d.length > CHUNK_CHARS * 1.1) return fail(msg.id, 'bad-chunk');
            if (!entry.parts[i]) {
                entry.parts[i] = d;
                entry.got += d.length;
                if (entry.got > entry.size) fail(msg.id, 'overflow');
            }
            return;
        }

        if (msg.type === 'img-end') {
            if (entry.got !== entry.size) return fail(msg.id, 'incomplete');
            const dataUrl = `data:${entry.mime};base64,${entry.parts.join('')}`;
            clearTimeout(entry.timer);
            incoming.delete(msg.id);
            if (DATA_URL_RE.test(dataUrl)) onDone({ from: entry.from, dataUrl, batch: entry.batch });
            else if (onFail) onFail('bad-data');
        }
    };
}

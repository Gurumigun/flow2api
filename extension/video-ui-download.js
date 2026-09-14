// Runs in the Flow page through chrome.scripting.executeScript. All dependencies
// are local because Chrome serializes this function into the MAIN world.
async function downloadFlowVideoFromEditor(projectId, expectedMediaId, requestId) {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const text = value => String(value || "").replace(/\s+/g, " ").trim();
    const visible = node => Boolean(node && node.getBoundingClientRect().width && node.getBoundingClientRect().height);
    const label = node => text(node.getAttribute("aria-label") || node.textContent);
    const report = () => {
        window.__FLOW2API_BROWSER_SUBMIT_PROGRESS__ = { request_id: requestId, phase: "video_downloading", updated_at: Date.now() };
    };
    const waitFor = async (probe, timeout, description) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            report();
            const result = probe();
            if (result) return result;
            await pause(200);
        }
        throw new Error(`Timed out waiting for ${description}`);
    };
    const mediaId = await waitFor(() => {
        if (location.origin !== "https://flow.google.com") return null;
        const match = location.pathname.match(/^\/project\/([^/]+)\/edit\/([0-9a-f-]{36})\/?$/i);
        if (!match || match[1] !== projectId || (expectedMediaId && match[2] !== expectedMediaId)) return null;
        return match[2];
    }, 15000, "the generated video's own editor");
    const downloadButton = await waitFor(() => Array.from(document.querySelectorAll("button"))
        .find(node => visible(node) && !node.disabled && /^(미디어 다운로드|download media)$/i.test(label(node))),
    15000, "video download menu");

    const readMp4 = async rawUrl => {
        const url = new URL(rawUrl, location.href);
        const allowed = (url.protocol === "blob:" && url.origin === location.origin)
            || (url.protocol === "https:" && !url.username && !url.password && (
                ["flow.google.com", "flow-content.google", "lh3.google.com"].includes(url.hostname)
                || /(^|\.)googleusercontent\.com$/.test(url.hostname)
            ));
        if (!allowed) throw new Error("Blocked non-Flow video download URL");
        const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(45000) });
        if (!response.ok || !response.body) throw new Error(`Flow video download failed (${response.status})`);
        const reader = response.body.getReader();
        const chunks = []; let length = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                length += value.length;
                if (length > 10 * 1024 * 1024) throw new Error("Flow video exceeds 10MB");
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        if (length < 32 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") throw new Error("Flow download is not an MP4");
        const view = new DataView(bytes.buffer);
        const typeAt = i => String.fromCharCode(...bytes.subarray(i + 4, i + 8));
        let duration = 0;
        for (let i = 0; i + 8 <= length;) {
            const size = view.getUint32(i);
            if (size < 8 || i + size > length) break;
            if (typeAt(i) === "moov") {
                for (let j = i + 8; j + 8 <= i + size;) {
                    const childSize = view.getUint32(j);
                    if (childSize < 8 || j + childSize > i + size) break;
                    if (typeAt(j) === "mvhd") {
                        const version = bytes[j + 8];
                        if (version === 0 && childSize >= 28) duration = view.getUint32(j + 24) / view.getUint32(j + 20);
                        if (version === 1 && childSize >= 40) duration = Number(view.getBigUint64(j + 32)) / view.getUint32(j + 28);
                    }
                    j += childSize;
                }
            }
            i += size;
        }
        if (!Number.isFinite(duration) || duration < 7.9 || duration > 8.2) throw new Error("Flow video is not the requested 8-second clip");
        let binary = "";
        for (let i = 0; i < length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { encodedVideo: btoa(binary), duration: `${duration}s` };
    };

    const originalClick = HTMLAnchorElement.prototype.click;
    let downloadPromise;
    let captureError;
    const captureClick = function (...args) {
        if (this.download && /\.mp4$/i.test(this.download)) {
            if (!downloadPromise) {
                // Start reading before Flow immediately revokes a temporary blob URL.
                downloadPromise = readMp4(this.href);
                downloadPromise.catch(error => { captureError = error; });
            }
            return;
        }
        return originalClick.apply(this, args);
    };
    const heartbeat = setInterval(report, 1000);
    HTMLAnchorElement.prototype.click = captureClick;
    try {
        downloadButton.click();
        const originalSize = await waitFor(() => Array.from(document.querySelectorAll('[role="menuitem"]'))
            .find(node => visible(node) && node.getAttribute("aria-disabled") !== "true"
                && /720p/.test(label(node)) && /원본 크기|original size/i.test(label(node))),
        5000, "720p original video option");
        originalSize.click();
        await waitFor(() => Boolean(downloadPromise), 45000, "Flow's MP4 download");
        if (captureError) throw captureError;
        return { mediaId, ...await downloadPromise };
    } finally {
        clearInterval(heartbeat);
        if (HTMLAnchorElement.prototype.click === captureClick) HTMLAnchorElement.prototype.click = originalClick;
    }
}

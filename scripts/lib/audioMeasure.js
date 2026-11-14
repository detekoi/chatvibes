// scripts/lib/audioMeasure.js
// Objective measurements of a speech clip, shared by the probe and voice-map scripts.
// Needs ffmpeg on the PATH.

import { execFileSync } from 'child_process';

function decodePcm(file) {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
        { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
}

/**
 * Length, loudness of the voiced frames, and median pitch by autocorrelation.
 * @param {string} file - Any audio file that ffmpeg can read
 * @returns {{durationSec: number, f0Hz: number|null, loudnessDb: number|null}|{measureError: string}}
 */
export function measure(file) {
    try {
        const pcm = decodePcm(file);
        const rate = 16000, frame = 800, hop = 400;
        const pitches = [];
        let voicedEnergy = 0, voicedCount = 0;
        for (let start = 0; start + frame <= pcm.length; start += hop) {
            let energy = 0;
            for (let i = 0; i < frame; i++) energy += pcm[start + i] * pcm[start + i];
            if (Math.sqrt(energy / frame) < 300) continue; // silence
            voicedEnergy += energy; voicedCount += frame;
            let best = 0, bestLag = 0;
            for (let lag = 40; lag <= 320; lag++) { // 400 Hz down to 50 Hz
                let num = 0, a = 0, b = 0;
                for (let i = 0; i + lag < frame; i++) {
                    const x = pcm[start + i], y = pcm[start + i + lag];
                    num += x * y; a += x * x; b += y * y;
                }
                const r = num / Math.sqrt(a * b || 1);
                if (r > best) { best = r; bestLag = lag; }
            }
            if (best > 0.6) pitches.push(rate / bestLag);
        }
        pitches.sort((a, b) => a - b);
        const f0 = pitches[Math.floor(pitches.length / 2)];
        return {
            durationSec: +(pcm.length / rate).toFixed(2),
            f0Hz: f0 ? Math.round(f0) : null,
            loudnessDb: voicedCount ? +(20 * Math.log10(Math.sqrt(voicedEnergy / voicedCount) / 32768)).toFixed(1) : null,
        };
    } catch (err) {
        return { measureError: err.message.slice(0, 160) };
    }
}

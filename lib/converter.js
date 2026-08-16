// lib/converter.js
//
// Small ffmpeg-based conversion helpers for INCONNU XD V2.
// Requires the `ffmpeg` binary to be installed and on PATH
// (e.g. `apt install ffmpeg` on the Railway/Debian image, or
// bundled via the `ffmpeg-static` npm package).

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Prefer the `FFMPEG_PATH` env var (handy if using ffmpeg-static),
// otherwise fall back to whatever `ffmpeg` resolves to on PATH.
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

function tmpFile(ext) {
  return path.join(os.tmpdir(), `inconnu-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext ? `.${ext}` : ''}`);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, args);

    let stderr = '';
    ff.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ff.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`ffmpeg binary not found ("${FFMPEG_BIN}"). Install ffmpeg or set FFMPEG_PATH.`));
      } else {
        reject(new Error(`ffmpeg failed to start: ${err.message}`));
      }
    });

    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

async function cleanup(paths) {
  await Promise.all(paths.map((p) => fsp.unlink(p).catch(() => {})));
}

/**
 * Run an ffmpeg conversion on an in-memory buffer by round-tripping
 * through temp files (ffmpeg needs seekable files for most containers).
 */
async function convert(inputBuffer, { inputExt = '', outputExt, args }) {
  const inputPath = tmpFile(inputExt);
  const outputPath = tmpFile(outputExt);

  await fsp.writeFile(inputPath, inputBuffer);

  try {
    await runFfmpeg(['-y', '-i', inputPath, ...args, outputPath]);
    return await fsp.readFile(outputPath);
  } finally {
    await cleanup([inputPath, outputPath]);
  }
}

/**
 * Convert any audio/video buffer to a standard MP3 buffer.
 * Used by the `play` command to normalize whatever the download
 * API returns (webm/m4a/opus/etc.) into an mp3 WhatsApp can play.
 *
 * @param {Buffer} inputBuffer
 * @param {{ bitrate?: string }} [options]
 * @returns {Promise<Buffer>}
 */
async function toAudio(inputBuffer, options = {}) {
  const { bitrate = '128k' } = options;
  return convert(inputBuffer, {
    outputExt: 'mp3',
    args: ['-vn', '-ar', '44100', '-ac', '2', '-b:a', bitrate, '-f', 'mp3'],
  });
}

/**
 * Convert audio to WhatsApp voice-note format (mono OGG/Opus).
 *
 * @param {Buffer} inputBuffer
 * @returns {Promise<Buffer>}
 */
async function toPTT(inputBuffer) {
  return convert(inputBuffer, {
    outputExt: 'ogg',
    args: ['-vn', '-ar', '48000', '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg'],
  });
}

/**
 * Normalize a video buffer to MP4 (H.264/AAC), useful if a downloader
 * API returns a container WhatsApp can't preview (mkv/avi/webm/etc.).
 * Also repairs corrupted or incomplete video files.
 *
 * @param {Buffer} inputBuffer
 * @param {Object} options - Optional settings
 * @param {number} options.quality - 1-31 (lower = better quality). Default 23.
 * @returns {Promise<Buffer>}
 */
async function toMP4(inputBuffer, options = {}) {
  const quality = options.quality || 23;
  
  return convert(inputBuffer, {
    outputExt: 'mp4',
    args: [
      '-c:v', 'libx264',
      '-crf', String(quality),
      '-preset', 'fast',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    ],
  });
}

/**
 * Alias for toMP4 - normalizes video to MP4 format.
 * Useful for repairing corrupted video files.
 *
 * @param {Buffer} inputBuffer
 * @returns {Promise<Buffer>}
 */
async function toVideo(inputBuffer) {
  return toMP4(inputBuffer);
}

// EXPORTS
module.exports = {
  toAudio,
  toPTT,
  toMP4,
  toVideo,
  convert,
  runFfmpeg,
  FFMPEG_BIN
};
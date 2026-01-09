import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "node:https";
import { spawn } from "node:child_process";

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { Server } from "socket.io";

const FFMPEG_PATH = ffmpegInstaller.path;
console.log(`[INIT] FFmpeg path: ${FFMPEG_PATH}`);

const VIDEO_OUTPUT_FOLDER = "./videos";
const STATIC_DIR = "./client";
const SERVER_PORT = process.env.PORT || 3000;

if (!fs.existsSync(VIDEO_OUTPUT_FOLDER)) {
    fs.mkdirSync(VIDEO_OUTPUT_FOLDER);
}

const httpsOptions = {
    key: fs.readFileSync("./certs/key.pem"),
    cert: fs.readFileSync("./certs/cert.pem"),
};

const httpsServer = createServer(httpsOptions, (request, response) => {
    const url = request.url;
    if (!url) {
        response.writeHead(404);
        response.end("Not found");
        return;
    }
    const filePath = path.join(
        STATIC_DIR,
        url === "/" ? "index.html" : url.slice(1)
    );
    serveStaticFile(request, response, filePath);
});

const io = new Server(httpsServer, {
    maxHttpBufferSize: 1e8, // 100MB
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const activeConnections = new Map();

io.on("connection", (socket) => {
    console.log(`[INFO] Client connected: ${socket.id}`);

    socket.on("start-stream", () => {
        if (activeConnections.has(socket.id)) return;

        const recordPath = `${VIDEO_OUTPUT_FOLDER}/stream-${getTimestamp()}-${socket.id}.mp4`;
        console.log(`[REC] Starting continuous recording: ${recordPath}`);

        const inputStream = new PassThrough();
        
        // FFmpeg args to handle variable resolution and mid-stream header resets
        const args = [
            "-loglevel", "info",
            "-thread_queue_size", "1024",
            "-i", "pipe:0",
            // Video normalization: scale and pad to 1080p to handle camera flips/orientation
            "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "20",
            "-b:v", "10M",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            "-y",
            recordPath
        ];

        const ffmpegProc = spawn(FFMPEG_PATH, args);

        ffmpegProc.stderr.on("data", (data) => {
            const msg = data.toString();
            if (msg.includes("Error") || msg.includes("error")) {
                console.error(`[FFMPEG ERROR] ${socket.id}: ${msg.trim()}`);
            }
        });

        ffmpegProc.on("close", (code) => {
            console.log(`[REC] FFmpeg process closed for ${socket.id} with code ${code}`);
            if (code === 0) {
                console.log(`[SUCCESS] Video saved: ${recordPath}`);
            }
            activeConnections.delete(socket.id);
        });

        inputStream.pipe(ffmpegProc.stdin);

        activeConnections.set(socket.id, {
            ffmpegProc,
            inputStream,
            recordPath
        });
    });

    socket.on("video-chunk", (data) => {
        const state = activeConnections.get(socket.id);
        if (state && state.inputStream.writable) {
            state.inputStream.write(Buffer.from(data));
        }
    });

    socket.on("stop-stream", () => {
        handleCleanup(socket.id);
    });

    socket.on("disconnect", () => {
        handleCleanup(socket.id);
    });
});

function handleCleanup(id) {
    const state = activeConnections.get(id);
    if (!state) return;

    console.log(`[INFO] Cleaning up connection for ${id}`);
    
    if (state.inputStream.writable) {
        state.inputStream.end();
    }

    // Process is deleted only when FFmpeg actually closes
    // This ensures all buffers are flushed to the MP4 file
}

function serveStaticFile(req, response, filePath) {
    fs.readFile(filePath, (err, content) => {
        if (err) {
            response.writeHead(404);
            response.end("Not found");
            return;
        }
        const ext = path.extname(filePath);
        const mimeTypes = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml" };
        response.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
        response.end(content);
    });
}

function getTimestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

httpsServer.listen(SERVER_PORT, "0.0.0.0", () => {
    console.log(`Server running at https://localhost:${SERVER_PORT}`);
});

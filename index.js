import fs from "node:fs";
import ffmpeg from "fluent-ffmpeg";
import { Server } from "socket.io";
import { createServer } from "node:https";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Domain } from "node:domain";

const VIDEO_OUTPUT_FOLDER = "./videos";
const STATIC_DIR = "./client";

const SERVER_PORT = process.env.PORT || 3000;

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

const domain = new Domain();
domain.on("error", (err) => {
    console.error("Domain error:", err);
});

domain.run(() => {
    httpsServer.listen(SERVER_PORT, () => {
        console.log(`Server running on port ${SERVER_PORT}`);
    });
});

const io = new Server(httpsServer, {
    maxHttpBufferSize: 1e8,
});

/** @type {Map<string, RecordingStream>} */
const clients = new Map();

io.on("connection", (socket) => {
    console.log(`connected to ${socket.id}`);
    socket.conn.on("upgrade", (transport) => {
        console.debug(`transport upgraded to ${transport.name}`);
    });

    socket.on("start-stream", (encoding) => {
        console.log(`starting stream: ${socket.id}`);
        const stream = startRecording(socket.id, encoding.split("/")[1]);
        clients.set(socket.id, stream);
    });

    socket.on("data", (data) => {
        console.log(`Received data from ${socket.id}: ${data.length} bytes`);
        const client = clients.get(socket.id);
        if (!client) {
            console.error(`[ERROR] Could not find client ${socket.id}`);
            return;
        }
        client.data.push(data);
    });

    socket.on("end-stream", () => {
        console.log(`[INFO] Ending stream: ${socket.id}`);
        endStream(socket.id);
    });

    socket.on("disconnect", (reason) => {
        console.error(`Disconnected to ${socket.id} due to ${reason}`);
        endStream(socket.id);
    });
});

/**
 * @param {string} id
 */
function endStream(id) {
    const client = clients.get(id);
    if (!client) {
        console.log(`[INFO] Client ${id} was not streaming`);
        return;
    }

    console.log("[INFO] Merging stream segments together ...");
    client.data.end();
    clients.delete(id);
}

/**
 * @param {import("http").IncomingMessage} _req
 * @param {import("http").ServerResponse<import("http").IncomingMessage> & { req: import("http").IncomingMessage; }} response
 * @param {fs.PathOrFileDescriptor} filePath
 */
function serveStaticFile(_req, response, filePath) {
    fs.readFile(filePath, "utf8", (err, content) => {
        if (err) {
            console.error("Error reading file:", err);
            response.writeHead(404);
            response.end("Not found");
            return;
        }

        const extname = path.extname(String(filePath));
        let contentType = "text/plain";

        switch (extname) {
            case ".html":
                contentType = "text/html";
                break;
            case ".css":
                contentType = "text/css";
                break;
            case ".js":
                contentType = "application/javascript";
                break;
            case ".json":
                contentType = "application/json";
                break;
            case ".png":
                contentType = "image/png";
                break;
            case ".jpg":
                contentType = "image/jpg";
                break;
            case ".gif":
                contentType = "image/gif";
                break;
            default:
                contentType = "text/plain";
        }

        response.setHeader("Content-type", contentType);
        response.end(content);
    });
}

/**
 * Represents a media stream object.
 *
 * @typedef {Object} RecordingStream
 * @property {string} id - client ID
 * @property {string} recordPath - The file path where the stream will be recorded.
 * @property {PassThrough} data - data buffer.
 * @property {boolean} recordEnd - Indicates whether the FFMPEG recording has ended.
 * @property {boolean} end - Indicates whether the WebRTC stream has ended.
 */

/**
 * @param {string} id - Client ID
 * @param {string} encoding - The video encoding of the media recorder data.
 * @returns {RecordingStream}
 * */
function startRecording(id, encoding) {
    /** @type {RecordingStream} */
    const stream = {
        id,
        recordPath: `${VIDEO_OUTPUT_FOLDER}/stream-${getTimestamp()}.mp4`,
        data: new PassThrough(),
        recordEnd: false,
        end: false,
    };

    recordStream(stream, encoding);

    return stream;
}

function getTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * @param {RecordingStream} stream
 * @param {string} mime
 *
 * @returns {ffmpeg.FfmpegCommand}
 */
function recordStream(stream, mime) {
    const process = ffmpeg()
        .addInput(stream.data)
        .addInputOptions([`-f ${mime}`])
        .on("start", (command) => {
            console.log("[Starting] recording >> ", stream.recordPath);
            console.log(command);
        })
        .on("error", (err, stdout, stderr) => {
            console.error("Error processing video:", err.message);
            console.error("FFmpeg output:", stdout);
            console.error("FFmpeg error:", stderr);
        })
        .on("end", () => {
            stream.recordEnd = true;
            console.log("[Stopping] recording >> ", stream.recordPath);
        })
        .output(stream.recordPath)
        .outputOptions([
            "-preset ultrafast", // Encoding:compression speed (ultrafast->superfast->veryfast->faster->fast->medium->slow->slower->veryslow)
            "-tune zerolatency",
            "-vcodec libx264", // libx265 uses less space but is slower. (https://www.reddit.com/r/ffmpeg/comments/idr0ud/comment/g2bff2f/)
            "-movflags frag_keyframe+empty_moov",
        ]);

    process.run();

    return process;
}

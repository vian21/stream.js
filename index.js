import fs from "fs";
import webRTC from "@roamhq/wrtc";
import ffmpeg from "fluent-ffmpeg";
import { Server } from "socket.io";
import { createServer } from "node:https";
import path from "path";
import { StreamInput } from "fluent-ffmpeg-multistream";
import { PassThrough } from "stream";

const { RTCVideoSink, RTCAudioSink } = webRTC.nonstandard;

const VIDEO_OUTPUT_FOLDER = "./videos";
const STATIC_DIR = "./client";

const VIDEO_RESOLUTION = "1920x1080";

/** ID to identify the RecordingStream (counter) recording */
let streamChunkID = 0;

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

httpsServer.listen(SERVER_PORT, () => {
    console.log(`Server running on port ${SERVER_PORT}`);
});

const io = new Server(httpsServer);

/**
 * @type {webRTC.RTCPeerConnection | null}
 */
let peerConnection = null;

io.on("connection", (socket) => {
    console.log(`connected to ${socket.id}`);
    socket.conn.on("upgrade", (transport) => {
        console.debug(`transport upgraded to ${transport.name}`);
    });

    socket.on("disconnect", (reason) => {
        console.log(`Disconnected to ${socket.id} due to ${reason}`);
        closePeerConnection();
    });

    // end peerConnection because it takes ~10s for it to propagate to the server after a client disconnects
    socket.on("end-stream", () => {
        console.log(`Ending stream: ${socket.id}`);
        closePeerConnection();
    });

    socket.on("init-rtc", async () => {
        console.log("Received connect msg");
        peerConnection = new webRTC.RTCPeerConnection();

        peerConnection.onicecandidate = (event) => {
            console.debug("[TRACE] Sending candidate event");
            if (!event?.candidate) {
                console.error("Ice candidate empty!");
                return;
            }
            socket.emit("ice-candidate", event.candidate);
        };

        beforeOffer();

        // Create and send offer to the server
        console.debug("[TRACE] Creating offer");
        const offer = await peerConnection?.createOffer();
        await peerConnection?.setLocalDescription(offer);

        console.debug("[TRACE] sending offer");
        socket.emit("offer", offer);
    });

    socket.on(
        "answer",
        async (/** @type {RTCSessionDescriptionInit} */ answer) => {
            console.log("Got answer from client");
            const remoteDescription = new webRTC.RTCSessionDescription(answer);
            await peerConnection?.setRemoteDescription(remoteDescription);
        }
    );
});

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
 * @type {{ recordPath: string; size: string; video: PassThrough; audio: PassThrough; recordEnd: boolean; end: boolean; proc?: ffmpeg.FfmpegCommand }}
 */
/**
 * Represents a media stream object.
 *
 * @typedef {Object} RecordingStream
 * @property {string} recordPath - The file path where the stream will be recorded.
 * @property {string} size - The size of the stream.
 * @property {PassThrough} video - Video buffer.
 * @property {PassThrough} audio - Audio buffer.
 * @property {boolean} recordEnd - Indicates whether the FFMPEG recording has ended.
 * @property {boolean} end - Indicates whether the WebRTC stream has ended.
 */

/**
 * This function initializes an audio and video transceiver and starts recording the stream.
 * It also listens for the end of the peer connection to merge the streams.
 *
 * It also registers a custom peer connection closing procedure
 *
 * @returns {void}
 */
function beforeOffer() {
    if (!peerConnection) {
        console.error("[DEBUG] Peer connection not initialized!");
        return;
    }
    console.debug("[TRACE] Waiting for frames");
    const audioTransceiver = peerConnection.addTransceiver("audio");
    const videoTransceiver = peerConnection.addTransceiver("video");

    const audioSink = new RTCAudioSink(audioTransceiver.receiver.track);
    const videoSink = new RTCVideoSink(videoTransceiver.receiver.track);

    /**
     * The client can send frames of different sizes, so we need to create a new stream for each .
     * In the end, we will merge all streams into a single video file.
     *
     * @type {RecordingStream[]}
     */
    const streams = [];
    streamChunkID = 0;

    // Triggerd every time a frame is received from client
    videoSink.addEventListener(
        "frame",
        async (/** @type {any} */ { frame: { width, height, data } }) => {
            const size = width + "x" + height;
            if (!streams[0] || (streams[0] && streams[0].size !== size)) {
                streamChunkID++;

                /** @type {RecordingStream} */
                const stream = {
                    recordPath: `${VIDEO_OUTPUT_FOLDER}/tmp-${getTimestamp()}-${size}-${streamChunkID}.webm`,
                    size,
                    video: new PassThrough(),
                    audio: new PassThrough(),
                    recordEnd: false,
                    end: false,
                };

                /**
                 * @param {{ samples: { buffer: ArrayBuffer } }} param0
                 */
                const onAudioData = ({ samples: { buffer } }) => {
                    if (!stream.end) {
                        stream.audio.push(Buffer.from(buffer));
                    }
                };

                audioSink.addEventListener(
                    "data",
                    /** @type {any} */ (onAudioData)
                );

                stream.audio.on("end", () => {
                    audioSink.removeEventListener(
                        "data",
                        /** @type {any} */ (onAudioData)
                    );
                });

                // Add the new stream to the beginning of the array
                streams.unshift(stream);

                // Close previous streams before starting a new one
                streams.forEach((streamEntry) => {
                    if (!streamEntry.end && streamEntry !== stream) {
                        streamEntry.end = true;

                        streamEntry.audio.end();
                        streamEntry.video.end();
                    }
                });

                // Start recording the new stream @beginning of the array
                await recordStream(stream);
            }

            if (streams[0].video.writable) {
                streams[0].video.push(Buffer.from(data));
            }
        }
    );

    const { close } = peerConnection;

    // Override the close method to handle recordings and merging them
    peerConnection.close = function () {
        audioSink.stop();
        videoSink.stop();

        // Ensure all streams are closed
        streams.forEach(({ audio, video }) => {
            audio.end();
            video.end();
        });

        /** Checks every second that all streams have ended to merge them */
        const timer = setInterval(() => {
            if (!streams.every((stream) => stream.recordEnd)) return;

            clearTimeout(timer);
            mergeStreams(streams);
        }, 1000);

        return close.apply(this);
    };

    peerConnection.oniceconnectionstatechange = () => {
        if (
            peerConnection &&
            (peerConnection.iceConnectionState === "disconnected" ||
                peerConnection.iceConnectionState === "failed" ||
                peerConnection.iceConnectionState === "closed")
        ) {
            console.log("[EVENT] Peer connection closed");
            closePeerConnection();
        }
    };
}

function closePeerConnection() {
    if (!peerConnection) {
        console.error("[closePeerConnection] Peer connection not initialized!");
        return;
    }

    peerConnection.close();
    peerConnection = null;
}

function getTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * @param {RecordingStream} stream
 * @returns {Promise<void>}
 */
async function recordStream(stream) {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .addInput(StreamInput(stream.video).url)
            .addInputOptions([
                "-re",
                "-pix_fmt yuv420p",
                "-vcodec rawvideo",
                "-f rawvideo",
                `-s ${stream.size}`,
                "-r 30",
            ])
            .addInput(StreamInput(stream.audio).url)
            .addInputOptions(["-f s16le", "-ar 48k", "-ac 1"])
            .on("start", (command) => {
                console.log("Start recording >> ", stream.recordPath);
                console.log(command);
            })
            .on("error", (err, stdout, stderr) => {
                console.error("Error processing video:", err.message);
                console.error("FFmpeg output:", stdout);
                console.error("FFmpeg error:", stderr);
                reject(err);
            })
            .on("end", () => {
                stream.recordEnd = true;
                console.log("Stop recording >> ", stream.recordPath);
                resolve();
            })
            .size(VIDEO_RESOLUTION)
            .output(stream.recordPath)
            .run();
    });
}

/**
 * @param {RecordingStream[]} streams
 */
function mergeStreams(streams) {
    const VIDEO_OUTPUT_FILE = `${VIDEO_OUTPUT_FOLDER}/stream-${getTimestamp()}.mp4`;
    const CONCAT_FILE = `${VIDEO_OUTPUT_FOLDER}/stream_list.txt`;

    const mergeProc = ffmpeg();

    mergeProc
        .on("start", (command) => {
            console.log("Start merging into", VIDEO_OUTPUT_FILE);
            console.log(command);
        })
        .on("error", (err, stdout, stderr) => {
            console.error("Error processing video:", err.message);
            console.error("FFmpeg output:", stdout);
            console.error("FFmpeg error:", stderr);
        })
        .on("end", () => {
            streams.forEach(({ recordPath }) => {
                if (fs.existsSync(recordPath)) {
                    fs.unlinkSync(recordPath);
                } else {
                    console.warn(`File not found: ${recordPath}`);
                }
            });

            if (fs.existsSync(CONCAT_FILE)) {
                fs.unlinkSync(CONCAT_FILE);
            }
            console.log("Merge end. You can play: " + VIDEO_OUTPUT_FILE);
        });

    let files = "";
    streams.reverse().forEach(({ recordPath }) => {
        files += `file '${path.basename(recordPath)}'\n`;
    });

    try {
        fs.writeFileSync(CONCAT_FILE, files);
    } catch (e) {
        console.error("[MergeStreams] Error writing to concat file:", e);
        return;
    }

    mergeProc
        .input(CONCAT_FILE)
        .inputOptions(["-f concat", "-safe 0"])
        .output(VIDEO_OUTPUT_FILE)
        .outputOptions(["-c copy"])
        .run();
}

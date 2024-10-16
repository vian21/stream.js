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

// ID to identify the stream (counter)
let streamID = 0;

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
        console.log(`transport upgraded to ${transport.name}`);
    });

    socket.on("disconnect", (reason) => {
        console.log(`disconnected to ${socket.id} due to ${reason}`);
    });

    // end peerConnection because it takes ~10s for it to propagate to the server after a client disconnects
    socket.on("end-stream", () => {
        console.log("Ending stream");
        closePeerConnection();
    });

    socket.on("init-rtc", async () => {
        console.log("Received connect msg");
        peerConnection = new webRTC.RTCPeerConnection();

        peerConnection.onicecandidate = (event) => {
            console.log("Candidate event");
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

function beforeOffer() {
    if (!peerConnection) {
        console.error("Peer connection not created");
        return;
    }
    console.debug("[TRACE] Waiting for frames");
    const audioTransceiver = peerConnection.addTransceiver("audio");
    const videoTransceiver = peerConnection.addTransceiver("video");

    const audioSink = new RTCAudioSink(audioTransceiver.receiver.track);
    const videoSink = new RTCVideoSink(videoTransceiver.receiver.track);

    /**
     * @type {{ recordPath: string; size: string; video: PassThrough; audio: PassThrough; recordEnd: boolean; end: boolean }[]}
     */
    const streams = [];

    videoSink.addEventListener(
        "frame",
        (/** @type {any} */ { frame: { width, height, data } }) => {
            const size = width + "x" + height;
            if (!streams[0] || (streams[0] && streams[0].size !== size)) {
                streamID++;

                /**
                 * @type {{ recordPath: string; size: string; video: PassThrough; audio: PassThrough; recordEnd: boolean; end: boolean; proc?: ffmpeg.FfmpegCommand }}
                 */
                const stream = {
                    recordPath: `${VIDEO_OUTPUT_FOLDER}/tmp-${size}-${streamID}.mp4`,
                    size,
                    video: new PassThrough(),
                    audio: new PassThrough(),
                    recordEnd: false,
                    end: false,
                    proc: undefined,
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

                streams.unshift(stream);

                streams.forEach((item) => {
                    if (item !== stream && !item.end) {
                        item.end = true;
                        if (item.audio) {
                            item.audio.end();
                        }
                        item.video.end();
                    }
                });

                console.log("stream size", stream.size);
                stream.proc = ffmpeg()
                    .addInput(StreamInput(stream.video).url)
                    .addInputOptions([
                        "-f",
                        "rawvideo",
                        "-pix_fmt",
                        "yuv420p",
                        "-s",
                        stream.size,
                        "-r",
                        "30",
                    ])
                    .addInput(StreamInput(stream.audio).url)
                    .addInputOptions(["-f s16le", "-ar 48k", "-ac 1"])
                    .on("start", () => {
                        console.log("Start recording >> ", stream.recordPath);
                    })
                    .on("end", () => {
                        stream.recordEnd = true;
                        console.log("Stop recording >> ", stream.recordPath);
                    })
                    .size(stream.size)
                    .output(stream.recordPath);

                stream.proc.run();
            }

            streams[0].video.push(Buffer.from(data));
        }
    );

    const { close } = peerConnection;
    peerConnection.close = function () {
        audioSink.stop();
        videoSink.stop();

        streams.forEach(({ audio, video, end }) => {
            if (!end) {
                if (audio) {
                    audio.end();
                }
                video.end();
            }
        });

        let totalEnd = 0;
        const timer = setInterval(() => {
            streams.forEach((stream) => {
                const timestamp = new Date()
                    .toISOString()
                    .replace(/[:.]/g, "-");
                const VIDEO_OUTPUT_FILE = `${VIDEO_OUTPUT_FOLDER}/stream-${timestamp}.mp4`;
                if (stream.recordEnd) {
                    totalEnd++;
                    if (totalEnd === streams.length) {
                        clearTimeout(timer);

                        const mergeProc = ffmpeg()
                            .on("start", () => {
                                console.log(
                                    "Start merging into " + VIDEO_OUTPUT_FILE
                                );
                            })
                            .on("end", () => {
                                streams.forEach(({ recordPath }) => {
                                    if (fs.existsSync(recordPath)) {
                                        fs.unlinkSync(recordPath);
                                    } else {
                                        console.warn(
                                            `File not found: ${recordPath}`
                                        );
                                    }
                                });
                                console.log(
                                    "Merge end. You can play " +
                                        VIDEO_OUTPUT_FILE
                                );
                            });

                        streams.forEach(({ recordPath }) => {
                            mergeProc.addInput(recordPath);
                        });

                        mergeProc.output(VIDEO_OUTPUT_FILE).run();
                    }
                }
            });
        }, 1000);

        return close.apply(this);
    };

    peerConnection.oniceconnectionstatechange = (event) => {
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

    peerConnection.onconnectionstatechange = null;
    peerConnection = null;
}

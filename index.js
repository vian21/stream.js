"use strict";

import fs from "fs";
import webRTC from "@roamhq/wrtc";
import ffmpeg from "fluent-ffmpeg";
import { Server } from "socket.io";
import { createServer } from "node:http";
import path from "path";
import { StreamInput } from "fluent-ffmpeg-multistream";
import { PassThrough } from "stream";

const { RTCVideoSink, RTCAudioSink } = webRTC.nonstandard;
const VIDEO_OUTPUT_FILE = "./recording.mp4";
const AUDIO_OUTPUT_FILE = "./recording.wav";

const VIDEO_OUTPUT_SIZE = "320x240";

const STATIC_DIR = "./client";
let UID = 0;

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

        const extname = path.extname(filePath);
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

const httpServer = createServer((request, response) => {
    const url = request.url;
    const filePath = path.join(
        STATIC_DIR,
        url === "/" ? "index.html" : url.slice(1)
    );

    serveStaticFile(request, response, filePath);
});

const SERVER_PORT = process.env.PORT || 3000;

httpServer.listen(SERVER_PORT, () => {
    console.log(`Server running on port ${SERVER_PORT}`);
});

const io = new Server(httpServer);

/**
 * @type {webRTC.RTCPeerConnection | undefined}
 */
let peerConnection = undefined;

io.on("connection", (socket) => {
    console.log(`connected to ${socket.id}`);
    socket.conn.on("upgrade", (transport) => {
        console.log(`transport upgraded to ${transport.name}`);
    });

    socket.on("disconnect", (reason) => {
        console.log(`disconnected to ${socket.id} due to ${reason}`);
        peerConnection?.close();
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

        beforeOffer(peerConnection);

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
 * @param {webRTC.RTCPeerConnection} peerConnection
 */
function beforeOffer(peerConnection) {
    console.debug("[TRACE] Waiting for frames");
    const audioTransceiver = peerConnection.addTransceiver("audio");
    const videoTransceiver = peerConnection.addTransceiver("video");

    const audioSink = new RTCAudioSink(audioTransceiver.receiver.track);
    const videoSink = new RTCVideoSink(videoTransceiver.receiver.track);

    const streams = [];

    videoSink.addEventListener(
        "frame",
        ({ frame: { width, height, data } }) => {
            const size = width + "x" + height;
            if (!streams[0] || (streams[0] && streams[0].size !== size)) {
                UID++;

                const stream = {
                    recordPath: "./recording-" + size + "-" + UID + ".mp4",
                    size,
                    video: new PassThrough(),
                    audio: new PassThrough(),
                };

                const onAudioData = ({ samples: { buffer } }) => {
                    if (!stream.end) {
                        stream.audio.push(Buffer.from(buffer));
                    }
                };

                audioSink.addEventListener("data", onAudioData);

                stream.audio.on("end", () => {
                    audioSink.removeEventListener("data", onAudioData);
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
                    .size(VIDEO_OUTPUT_SIZE)
                    .output(stream.recordPath);

                stream.proc.run();
            }

            streams[0].video.push(Buffer.from(data));
        }
    );

    const { close } = peerConnection;
    peerConnection.close = function () {
        console.log("Closing peer connection");
        audioSink.stop();
        videoSink.stop();

        streams.forEach(({ audio, video, end, proc, recordPath }) => {
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
                                    fs.unlinkSync(recordPath);
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

        return close.apply(this, arguments);
    };

    peerConnection.oniceconnectionstatechange = (event) => {
        if (
            peerConnection.iceConnectionState === "disconnected" ||
            peerConnection.iceConnectionState === "failed" ||
            peerConnection.iceConnectionState === "closed"
        ) {
            console.log("[EVENT] Peer connection closed");
            peerConnection.close();
        }
    };
}

"use strict";

// https://web.dev/articles/webrtc-basics
// https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
let frontFacing = true;
let isRecording = false;
let isConnected = false;

/** @type MediaStream | undefined */
let stream = undefined;

/** @type MediaStreamTrack | undefined */
let videoStream = undefined;

/** @type MediaStreamTrack | undefined */
let audioStream = undefined;

/** @type HTMLElement | null */
let streamButton = null;

/** @type HTMLVideoElement | null */
let videoCanvas = null;

/** @type Socket | null */
let socket = null;

/** @type RTCPeerConnection | null */
let peerConnection = null;

const constraints = {
    audio: false,
    video: { facingMode: frontFacing ? "user" : "environment" },
};

/**
 * @param {MediaStream} stream
 */
async function handleSuccess(stream) {
    videoStream = stream.getVideoTracks()[0];
    audioStream = stream.getAudioTracks()[0];

    console.log("Got stream with constraints:", constraints);
    console.log(`Using video device: ${videoStream.label}`);

    if (!videoCanvas) {
        console.error("No video element found");
        return;
    }
    videoCanvas.srcObject = stream;

    await createPeerConnection();
}

function handleError(error) {
    console.error(error);

    if (error.name === "OverconstrainedError") {
        errorMsg(
            `OverconstrainedError: The constraints could not be satisfied by the available devices. Constraints: ${JSON.stringify(
                constraints
            )}`
        );
    } else if (error.name === "NotAllowedError") {
        errorMsg(
            "NotAllowedError: Permissions have not been granted to use your camera and " +
                "microphone, you need to allow the page access to your devices in " +
                "order for the demo to work."
        );
    }
    errorMsg(`getUserMedia error: ${error.name}`, error);
}

function errorMsg(msg) {
    const errorElement = document.querySelector("#errorMsg");
    errorElement.innerHTML += `<p>${msg}</p>`;
}
/**
 * @param {boolean} [isFlipping=false]
 * */
async function handleStream(isFlipping = false) {
    if (isRecording) {
        isRecording = false;
        if (streamButton) {
            streamButton.innerHTML = "Start";
        }

        //Release device if already acquired
        if (videoStream) {
            console.log("Closing video stream");
            videoStream.stop();
            if (videoCanvas) {
                videoCanvas.srcObject = null;
            }
        }

        if (audioStream) {
            audioStream.stop();
        }

        if (peerConnection) {
            console.log("Closing peer connection");
            const { close } = peerConnection;
            peerConnection.close = function () {
                stream?.getTracks().forEach((track) => track.stop());

                return close.apply(this, arguments);
            };
        }

        if (!isFlipping) {
            return;
        }
    }

    try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        handleSuccess(stream);

        isRecording = true;
        if (streamButton) {
            streamButton.innerHTML = "Stop";
        }
    } catch (e) {
        console.log(e);
        handleError(e);
    }
}

function connectToServer() {
    socket = io();

    socket.on("connect", () => {
        console.log(
            `connected with transport ${socket.io.engine.transport.name}`
        );
        isConnected = true;
    });

    socket.on("disconnect", (/** @type {String} */ reason) => {
        console.log(`disconnect due to ${reason}`);
        isConnected = false;
    });
}

async function createPeerConnection() {
    console.debug("[TRACE]Creating Peer connection");
    peerConnection = new RTCPeerConnection();

    socket.emit("init-rtc");

    // Add tracks to the peer connection
    stream?.getTracks().forEach((track) => {
        console.log("Adding track: ", track);
        peerConnection?.addTrack(track, stream);
    });

    socket.on("ice-candidate", async (candidate) => {
        try {
            console.log("Adding received ice candidate: ", candidate);
            await peerConnection?.addIceCandidate(candidate);
        } catch (e) {
            console.error("Error adding received ice candidate", e);
        }
    });

    socket.on("offer", async (offer) => {
        console.log("Received offer");
        const remoteDescription = new RTCSessionDescription(offer);

        peerConnection?.setRemoteDescription(remoteDescription);

        console.debug("[TRACE] creating WebRTC answer");
        const answer = await peerConnection?.createAnswer();
        await peerConnection?.setLocalDescription(answer);

        console.debug("[TRACE] sending WebRTC answer");
        socket.emit("answer", answer);
    });
}

window.onload = () => {
    connectToServer();
    videoCanvas = document.querySelector("#videoCanvas");
    streamButton = document.querySelector("#streamButton");

    streamButton?.addEventListener("click", () => handleStream());

    const flipCameraButton = document.querySelector("#flipCamera");
    flipCameraButton?.addEventListener("click", () => {
        frontFacing = !frontFacing;
        constraints.video = {
            facingMode: frontFacing ? "user" : "environment",
        };
        handleStream(true);
    });
};

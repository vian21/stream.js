// https://web.dev/articles/webrtc-basics
// https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
let frontFacing = true;
let isRecording = false;
let isConnected = false;

/** @type MediaStream | null */
let stream = null;

/** @type HTMLElement | null */
let streamButton = null;

/** @type HTMLVideoElement | null */
let videoCanvas = null;

/**
 * @type {any}
 */
let socket = null;

/** @type RTCPeerConnection | null */
let peerConnection = null;

const constraints = {
    audio: true,
    video: {
        facingMode: frontFacing ? "user" : "environment",
        frameRate: 30,
        width: 1920,
        height: 1080,
    },
};

/**
 * @param {MediaStream} stream
 */
async function handleSuccess(stream) {
    console.log("Got stream with constraints:", constraints);

    if (!videoCanvas) {
        console.error("No video element found");
        return;
    }
    videoCanvas.srcObject = stream;

    await createPeerConnection();
}

/**
 * @param {Error} error
 */
function displayError(error) {
    console.error(error);

    if (error.name === "OverconstrainedError") {
        errorMsg(
            `OverconstrainedError: The constraints could not be satisfied by the available devices. Constraints: ${JSON.stringify(
                constraints
            )}`
        );
    } else if (error.name === "NotAllowedError") {
        errorMsg(
            "NotAllowedError: The user has denied permission to use media devices"
        );
    }
    errorMsg(`Error: ${error.message}`);
}

/**
 * @param {string} msg
 */
function errorMsg(msg) {
    const errorElement = document.querySelector("#errorMsg");
    if (errorElement) {
        errorElement.innerHTML += `<p>${msg}</p>`;
    }
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

        if (videoCanvas) {
            videoCanvas.srcObject = null;
        }

        if (peerConnection !== null) {
            console.log("Closing peer connection");
            const { close } = peerConnection;
            peerConnection.close = function () {
                stream?.getTracks().forEach((track) => track.stop());
                return close.apply(this);
            };

            peerConnection.close();
            peerConnection = null;
            stream = null;
            socket.emit("end-stream");
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
        // @ts-ignore
        displayError(e);
    }
}

function connectToServer() {
    // @ts-ignore
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
    if (!socket) {
        console.error("No socket connection");
        return;
    }
    if (!stream) {
        console.error("No stream available");
        return;
    }

    peerConnection = new RTCPeerConnection();

    socket.emit("init-rtc");

    // Add tracks to the peer connection
    stream.getTracks().forEach((track) => {
        console.log("Adding track: ", track);
        // @ts-ignore
        peerConnection?.addTrack(track, stream);
    });

    socket.on(
        "ice-candidate",
        async (/** @type {RTCIceCandidateInit | undefined} */ candidate) => {
            try {
                console.log("Adding received ice candidate: ", candidate);
                await peerConnection?.addIceCandidate(candidate);
            } catch (e) {
                console.error("Error adding received ice candidate", e);
            }
        }
    );

    socket.on(
        "offer",
        async (/** @type {RTCSessionDescriptionInit} */ offer) => {
            console.log("Received offer");
            const remoteDescription = new RTCSessionDescription(offer);

            peerConnection?.setRemoteDescription(remoteDescription);

            console.debug("[TRACE] creating WebRTC answer");
            const answer = await peerConnection?.createAnswer();
            await peerConnection?.setLocalDescription(answer);

            console.debug("[TRACE] sending WebRTC answer");
            socket.emit("answer", answer);
        }
    );
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
            frameRate: 30,
            width: 1920,
            height: 1080,
        };
        handleStream(true);
    });
};

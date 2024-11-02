// https://web.dev/articles/webrtc-basics
// https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
let frontFacing = true;
let isRecording = false;

/** @type MediaStream | null */
let stream = null;

/** @type MediaRecorder | null */
let recorder = null;

/** @type HTMLElement | null */
let streamButton = null;

/** @type HTMLVideoElement | null */
let videoCanvas = null;

/**
 * @type {any}
 */
let socket = null;

const Kbits = 1e3;
const Mbits = 1e6;

const AUDIO_BITRATE = {
    LOSSLESS: 1411.2 * Kbits,
    SURROUND: 512 * Kbits,
    STEREO: 384 * Kbits,
    MONO: 128 * Kbits,
};

const VIDEO_BITRATE = {
    "8K": 100 * Mbits,
    "4K": 44 * Mbits,
    "2K": 20 * Mbits,
    "1080p": 10 * Mbits,
    "720p": 6.5 * Mbits,
};
const constraints = {
    audio: true,
    video: {
        facingMode: frontFacing ? "user" : "environment",
        frameRate: 30,
        width: { ideal: 4096 },
        height: { ideal: 2160 },
    },
};

/**
 * @param {MediaStream} stream
 */
async function handleSuccess(stream) {
    console.log("Got stream with constraints:", constraints);

    if (!videoCanvas) {
        console.error("[ERROR] No video element found");
        tearDown();
        return;
    }
    videoCanvas.srcObject = stream;

    const encoding = MediaRecorder.isTypeSupported("video/webm")
        ? "video/webm"
        : "video/mp4";

    socket.emit("start-stream", encoding);

    try {
        // https://support.google.com/youtube/answer/1722171#zippy=%2Cbitrate
        recorder = new MediaRecorder(stream, {
            mimeType: encoding,
            videoBitsPerSecond: VIDEO_BITRATE["1080p"],
            audioBitsPerSecond: AUDIO_BITRATE.MONO,
        });
    } catch (error) {
        socket.emit("end-stream");
        alert(error);
        tearDown();
        return;
    }

    recorder.ondataavailable = (event) => {
        socket.emit("data", event.data);
    };

    recorder.onstop = (event) => {
        console.log("[TRACE] stopping recording");
        socket.emit("end-stream");
    };

    recorder.start(1000);
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

function tearDown() {
    console.log("[TRACE] Tearing down stream");
    if (recorder) {
        recorder.stop();
        const tracks = stream?.getTracks();

        tracks?.forEach((track) => {
            track.stop();
        });
    }

    isRecording = false;
    stream = null;

    if (streamButton) {
        streamButton.innerHTML = "Start";
    }

    if (videoCanvas) {
        videoCanvas.srcObject = null;
    }
}

async function startRecording() {
    console.log(`[TRACE] ${isRecording ? "Stopping " : "Starting "} stream`);
    if (isRecording) {
        tearDown();
        return;
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
    });

    socket.on("disconnect", (/** @type {String} */ reason) => {
        console.log(`disconnect due to ${reason}`);
        if (isRecording) {
            tearDown();
        }
    });
}

window.onload = () => {
    videoCanvas = document.querySelector("#videoCanvas");
    streamButton = document.querySelector("#streamButton");

    streamButton?.addEventListener("click", () => startRecording());

    const flipCameraButton = document.querySelector("#flipCamera");
    flipCameraButton?.addEventListener("click", () => {
        console.log("[TRACE] Flipping camera");
        frontFacing = !frontFacing;
        // TODO: find a better way to flip the camera without interupting the stream
        constraints.video = {
            facingMode: frontFacing ? "user" : "environment",
            frameRate: 30,
            width: { ideal: 4096 },
            height: { ideal: 2160 },
        };
        startRecording();
    });

    connectToServer();
};

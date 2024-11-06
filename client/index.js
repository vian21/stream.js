// https://web.dev/articles/webrtc-basics
// https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
let frontFacing = true;
let isRecording = false;

/** @type MediaRecorder | null */
let recorder = null;

/**
 * @type {MediaSwitcher}
 */
const mediaSwitcher = new MediaSwitcher();

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

const recorderOptions = {
    mimeType: "video/webm",
    videoBitsPerSecond: VIDEO_BITRATE["1080p"],
    audioBitsPerSecond: AUDIO_BITRATE.MONO,
};

/**
 * @param {MediaStream} stream
 */
async function startRecording(stream) {
    console.log("Got stream with constraints:", constraints);

    if (!videoCanvas) {
        console.error("[ERROR] No video element found");
        tearDown();
        return;
    }

    if (!MediaRecorder.isTypeSupported("video/webm")) {
        recorderOptions.mimeType = "video/mp4";
    }

    socket.emit("start-stream", recorderOptions.mimeType);

    try {
        const switcher_stream = await mediaSwitcher.initialize(
            stream,
            recorderOptions
        );
        console.log("[TRACE] MediaSwitcher initialized");

        // https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event
        // [Important] Data has to be consumed from the stream for the `dataavailable` event to trigger
        videoCanvas.srcObject = switcher_stream;

        // https://support.google.com/youtube/answer/1722171#zippy=%2Cbitrate
        recorder = new MediaRecorder(switcher_stream, recorderOptions);

        recorder.ondataavailable = (event) => {
            socket.emit("data", event.data);
        };

        recorder.onstop = () => {
            socket.emit("end-stream");
        };

        recorder.start(1000);
        console.log("[TRACE] MediaRecorder started");
    } catch (error) {
        socket.emit("end-stream");
        console.error(error);
        tearDown();
        return;
    }
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
        mediaSwitcher.close();
    }

    isRecording = false;
    recorder = null;

    if (streamButton) {
        streamButton.innerHTML = "Start";
    }

    if (videoCanvas) {
        videoCanvas.srcObject = null;
    }
}

async function startStream() {
    console.log(`[TRACE] ${isRecording ? "Stopping " : "Starting "} stream`);
    if (isRecording) {
        tearDown();
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        await startRecording(stream);

        isRecording = true;
        if (streamButton) {
            streamButton.innerHTML = "Stop";
        }
    } catch (e) {
        // @ts-ignore
        displayError(e);
        console.error("[ERROR]", e);
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

async function flipCamera() {
    if (!isRecording || !videoCanvas) {
        return;
    }
    console.log("[TRACE] Flipping camera");

    frontFacing = !frontFacing;
    constraints.video.facingMode = frontFacing ? "user" : "environment";

    try {
        mediaSwitcher.getCurrentStreamTracks().forEach(async (track) => {
            console.log(`[TRACE] Stopping ${track?.kind} track`);
            track?.stop();
        });

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log("[INFO] Got new stream with constraints:", constraints);

        mediaSwitcher.changeStream(stream);
    } catch (error) {
        console.error("[ERROR] changing camera:", error);
        tearDown();
    }
}

window.onload = () => {
    videoCanvas = document.querySelector("#videoCanvas");
    streamButton = document.querySelector("#streamButton");

    streamButton?.addEventListener("click", () => startStream());

    const flipCameraButton = document.querySelector("#flipCamera");
    flipCameraButton?.addEventListener("click", () => flipCamera());

    connectToServer();
};

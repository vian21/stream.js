/**
MIT License

Copyright (c) 2020 Meething dWebRTC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
 */
class MediaSwitcher {
    /**
     * @type {RTCPeerConnection | null}
     */
    inputPeerConnection = null;
    /**
     * @type {RTCPeerConnection | null}
     */
    outputPeerConnection = null;

    //  Change the entire input stream
    changeStream = (/** @type {MediaStream} */ stream) => {
        if (
            !this.inputPeerConnection ||
            !this.outputPeerConnection ||
            this.inputPeerConnection.connectionState !== "connected" ||
            this.outputPeerConnection.connectionState !== "connected"
        )
            return;

        console.log("[TRACE] Changing stream");

        stream.getTracks().forEach(async (track) => {
            await this.changeTrack(track);
        });
    };

    //  Change one input track
    changeTrack = async (
        /** @type {MediaStreamTrack | CanvasCaptureMediaStreamTrack} */ track
    ) => {
        if (
            !this.inputPeerConnection ||
            !this.outputPeerConnection ||
            this.inputPeerConnection.connectionState !== "connected" ||
            this.outputPeerConnection.connectionState !== "connected"
        )
            return;

        const sender = this.inputPeerConnection
            .getSenders()
            .filter(
                (sender) => !!sender.track && sender.track.kind === track.kind
            )[0];
        if (!!sender) {
            console.log(`[TRACE] Replacing ${sender.track?.kind} track`);
            try {
                await sender.replaceTrack(track);
            } catch (e) {
                console.error(e);
            }
            console.log(track);
        }
    };

    getCurrentStreamTracks = () => {
        return this.inputPeerConnection?.getSenders().map((sender) => sender.track) || [];
    }

    //  Call this to, you guessed, initialize the class
    initialize = async function (
        /** @type {MediaStream} */ inputStream,
        /** @type {MediaRecorderOptions} */ constraints
    ) {
        return new Promise(async (resolve, reject) => {
            //  ---------------------------------------------------------------------------------------
            //  Create input RTC peer connection
            //  ---------------------------------------------------------------------------------------
            this.inputPeerConnection = new RTCPeerConnection();
            this.inputPeerConnection.onicecandidate = (e) => {
                if (!e.candidate) return;
                this.outputPeerConnection
                    .addIceCandidate(e.candidate)
                    .catch((err) => reject(err));
            };
            this.inputPeerConnection.ontrack = (e) => console.log(e.streams[0]);

            //  ---------------------------------------------------------------------------------------
            //  Create output RTC peer connection
            //  ---------------------------------------------------------------------------------------
            this.outputPeerConnection = new RTCPeerConnection();
            this.outputPeerConnection.onicecandidate = (e) => {
                if (!e.candidate) return;
                this.inputPeerConnection
                    .addIceCandidate(e.candidate)
                    .catch((err) => reject(err));
            };
            this.outputPeerConnection.ontrack = (e) => resolve(e.streams[0]);

            //  ---------------------------------------------------------------------------------------
            //  Get video source
            //  ---------------------------------------------------------------------------------------

            //  Add stream to input peer
            inputStream.getTracks().forEach((track) => {
                if (track.kind === "video")
                    this.inputPeerConnection.addTrack(track, inputStream);
                if (track.kind === "audio")
                    this.inputPeerConnection.addTrack(track, inputStream);
            });

            //  ---------------------------------------------------------------------------------------
            //  Make RTC call
            //  ---------------------------------------------------------------------------------------

            const offer = await this.inputPeerConnection.createOffer();
            await this.inputPeerConnection.setLocalDescription(offer);
            await this.outputPeerConnection.setRemoteDescription(offer);

            const answer = await this.outputPeerConnection.createAnswer();
            await this.outputPeerConnection.setLocalDescription(answer);
            await this.inputPeerConnection.setRemoteDescription(answer);
        });
    };

    close = () => {
        if (this.inputPeerConnection) {
            this.inputPeerConnection.getSenders().forEach((sender) => {
                sender.track?.stop();
            });
            this.inputPeerConnection.close();
            this.inputPeerConnection = null;
        }

        if (this.outputPeerConnection) {
            this.outputPeerConnection.close();
            this.outputPeerConnection = null;
        }
    };
}

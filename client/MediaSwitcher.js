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
            !stream ||
            stream.constructor.name !== "MediaStream" ||
            !this.inputPeerConnection ||
            !this.outputPeerConnection ||
            this.inputPeerConnection.connectionState !== "connected" ||
            this.outputPeerConnection.connectionState !== "connected"
        )
            return;

        stream.getTracks().forEach((track) => {
            this.changeTrack(track);
        });
    };

    //  Change one input track
    changeTrack = (/** @type {MediaStreamTrack} */ track) => {
        if (
            !track ||
            (track.constructor.name !== "MediaStreamTrack" &&
                track.constructor.name !== "CanvasCaptureMediaStreamTrack") ||
            !this.inputPeerConnection ||
            !this.outputPeerConnection ||
            this.inputPeerConnection.connectionState !== "connected" ||
            this.outputPeerConnection.connectionState !== "connected"
        )
            return;

        const senders = this.inputPeerConnection
            .getSenders()
            .filter(
                (sender) => !!sender.track && sender.track.kind === track.kind
            )[0];
        if (!!senders) {
            senders.track?.stop();
            senders.replaceTrack(track);
        }
    };

    //  Call this to, you guessed, initialize the class
    initialize = async function (/** @type {MediaStream} */ inputStream) {
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

            //  Create input stream
            if (
                !inputStream ||
                inputStream.constructor.name !== "MediaStream"
            ) {
                reject(new Error("Input stream is nonexistent or invalid."));
                return;
            }

            //  Add stream to input peer
            inputStream.getTracks().forEach((track) => {
                if (track.kind === "video")
                    this.videoSender = this.inputPeerConnection.addTrack(
                        track,
                        inputStream
                    );
                if (track.kind === "audio")
                    this.audioSender = this.inputPeerConnection.addTrack(
                        track,
                        inputStream
                    );
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
            this.outputPeerConnection.getSenders().forEach((sender) => {
                sender.track?.stop();
            });
            this.outputPeerConnection.close();
            this.outputPeerConnection = null;
        }
    };
}

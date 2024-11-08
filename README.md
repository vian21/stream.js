# Stream.js

Easily record your phone's stream to a computer.

## Setup

```bash
git clone https://github.com/vian21/stream.js.git
```

```bash
cd stream.js
npm install
```

## Usage

```bash
deno run start
```

-   To start development server run:

```bash
deno run dev
```

-   To compile to a single file run:

```bash
deno compile -A index.js
```

-   Visit your browser at `https://{HOST}:3000` (has to be over `HTTPS` because `getUserMedia` is only available on secure origins)
-   Now your recordings will be avaible under the `videos` folder

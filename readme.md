# Same-Room Dectection

Detect if devices are nearby and create a mesh of them automatically.

## Instructions for Build and Use

### Mesh-based field creator:

#### Server

1. Navigate to `./durable-object-server`
2. `npm install`
3. `npm run dev`

#### Client

1. Start a local static server from the root of the repo
    - `python -m http.server 8080`
    - or visit [field.beckersuite.com](https://field.beckersuite.com) (uses public server)
2. Open the above page on two devices (opening a local server on another device won't allow access to microphone permissions).
3. Type in a device name
4. Press `Start Search`
5. Accept permissions
6. Do all the same on another device
7. Wait for the devices to find each other (you may have to make some noise)

### Python evaluator:

1. Create the python venv: `python -m venv .venv`
2. Activate the env: `.\venv\Scripts\activate`
3. Run the data exploration: `cd data-exploration && python \evaluate_all_pairs.py`
4. Should return evaluation of all the pairs and how many failed.

### Web evaluator:

1. Start a local server from the root
    - `python -m http.server 8080`
    - or visit [https://21beckem.github.io/same-room-detector/web-peer-demo/](https://21beckem.github.io/same-room-detector/web-peer-demo/)
2. Open the above page on two devices (opening a local server on another device won't allow access to microphone permissions).
3. Start a session on one device, then type in the code in the other device (or scan the QR code).
4. Accept permissions
5. Wait around 15 seconds for scores to come in.

## Development Environment

To recreate the development environment, you need the following software and/or libraries with the specified versions:

* Python
* NodeJS  >=v22.0.0

## Future Work

The following items I plan to fix, improve, and/or add to this project in the future:

* [X] Mesh devices together to automatically discover peers and persist connections.
* [ ] Make meshing more stable if dealing with unstable clients
* [ ] Add more feedback to UI on status of ClientMesh library.
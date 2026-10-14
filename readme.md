# Same-Room Dectection

Add a description of your project here.

## Instructions for Build and Use

Python evaluator:

1. Create the python venv: `python -m venv .venv`
2. Activate the env: `.\venv\Scripts\activate`
3. Run the data exploration: `cd data-exploration && python \evaluate_all_pairs.py`
4. Should return evaluation of all the pairs and how many failed.

Web evaluator:

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

## Useful Websites to Learn More

I found these websites useful in developing this software:

* [Codex](https://openai.com/codex/)

## Future Work

The following items I plan to fix, improve, and/or add to this project in the future:

* [ ] Mesh devices together to automatically discover peers and persist connections.
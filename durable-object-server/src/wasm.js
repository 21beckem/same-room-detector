import loader from '@assemblyscript/loader';
import sameRoomModel from './same_room.wasm';
import model from './model.json';

let wasmInstancePromise;
function getWasmInstance() {
	wasmInstancePromise ??= loader.instantiate(sameRoomModel, {}).then(({ exports }) => {
		const config = model.config;
		exports.configure(
			model.intercept,
			model.mean[0],
			model.mean[1],
			model.std[0],
			model.std[1],
			model.coef[0],
			model.coef[1],
			config.window_sec,
			config.hop_sec,
			config.max_lag,
			config.min_sec,
		);
		return exports;
	});
	return wasmInstancePromise;
}

export async function compareAudioPackets(first, second) {
    if (!(first instanceof Uint8Array) || !(second instanceof Uint8Array))
        throw new Error('Both arguments must be Uint8Arrays');

    const wasm = await getWasmInstance();
    let firstHandle;
    let secondHandle;
    try {
        firstHandle = wasm.loadDevicePacket(wasm.__newArray(wasm.UINT8ARRAY_ID, first));
        secondHandle = wasm.loadDevicePacket(wasm.__newArray(wasm.UINT8ARRAY_ID, second));
        return wasm.compareDevices(firstHandle, secondHandle);
    } finally {
        if (firstHandle !== undefined) wasm.releaseDevice(firstHandle);
        if (secondHandle !== undefined) wasm.releaseDevice(secondHandle);
        wasm.__collect();
    }
}
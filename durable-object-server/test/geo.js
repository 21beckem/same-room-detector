let lat, lng;

let currentPromise = null;

export class Geo {
    /**
     * Requests the browser's current latitude and longitude.
     * @param {Object} [options] - Optional configurations (timeout, enableHighAccuracy, etc.)
     * @returns {Promise<{lat: number, lng: number}>}
     */
    static getLocation(options = { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }) {
        if (lat !== undefined && lng !== undefined) {
            return Promise.resolve({ lat, lng });
        }
        if (currentPromise) return currentPromise;

        currentPromise = new Promise((resolve, reject) => {
            if (!("geolocation" in navigator)) {
                return reject(new Error("Geolocation is not supported by this browser."));
            }

            navigator.geolocation.getCurrentPosition(
                (position) => {
                    lat = position.coords.latitude;
                    lng = position.coords.longitude;
                    resolve({ lat, lng });
                    currentPromise = null;
                },
                (error) => {
                    reject(error);
                    currentPromise = null;
                },
                options
            );
        });
        return currentPromise;
    }
};
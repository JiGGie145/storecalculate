import PocketBase from 'pocketbase';

const endpoint = import.meta.env.VITE_POCKETBASE_URL;

export const pb = endpoint ? new PocketBase(endpoint) : null;

if (pb) {
    pb.autoCancellation(false);
}
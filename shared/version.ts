/**
 * The app version, baked into both the server module and the device UI at
 * build time. When they differ, the device is still showing an old page after
 * an update, and reloads itself.
 */
import pkg from '../package.json';

export const APP_VERSION: string = pkg.version;

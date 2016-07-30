'use strict';

const EventEmitter = require('events');
const Firebase = require('firebase');
const request = require('request');
const _ = require('underscore');

/**
 * Class that represents a single Nest account. It requires an
 * accessToken and will keep up-to-date lists of all devices and
 * structures in the Nest account.
 */
class NestAccount extends EventEmitter {

	/**
	 * Create NestAccount instance, provide options object
	 * with accessToken property to start authentication
	 * immediately. Starts listening for realtime updates
	 * from database.
	 * @param options
	 */
	constructor(options) {
		super();

		// Store provided options in this
		Object.assign(this, options);

		// Reference to Firebase database
		this.db = new Firebase('wss://developer-api.nest.com');

		// Authenticate NestAccount
		this.authenticate();

		// Keep track of devices in Nest API
		this.thermostats = [];
		this.smoke_co_alarms = [];
		this.cameras = [];

		// Keep track of structures in Nest API
		this.structures = [];

		// Start listening for realtime updates from Nest API
		this._listenForRealtimeUpdates().then(() => this.emit('initialized'));
	}

	/**
	 * Authenticate with Nest API using accessToken
	 * stored in this instance or if provided
	 * the parameter accessToken.
	 * @param accessToken
	 * @returns {Promise}
	 */
	authenticate(accessToken) {
		return new Promise((resolve, reject) => {

			// Store provided accessToken
			if (accessToken) this.accessToken = accessToken;

			// Reject if no accessToken is found
			if (!this.accessToken) return reject('NestAccount: no access token available');

			// Check if not authenticated yet
			if (!this.db.getAuth()) {

				// Authenticate using accessToken
				this.db.authWithCustomToken(this.accessToken, err => {
					if (err) {

						console.error(err, 'NestAccount: failed to authenticate');

						return reject(err);
					}

					// Attach listener to auth state
					this.db.onAuth(authData => {
						if (authData === null) this.emit('unauthenticated');
						else this.emit('authenticated');
					});

					console.log('NestAccount: authentication successful');

					return resolve();
				});
			} else return resolve();
		});
	}

	/**
	 * Removes the authenticated connection between Homey and the Nest API.
	 * @returns {Promise}
	 */
	revokeAuthentication() {
		return new Promise((resolve, reject) => {

			// Unauth Firebase reference
			this.db.unauth();

			// Post authorization url with needed credentials
			request.del(
				`https://api.home.nest.com/oauth2/access_tokens/${this.accessToken}`, {}, (err, response) => {
					if (err || response.statusCode >= 400) {
						console.error(err || response.statusCode, 'NestAccount: failed to revoke authentication');
						return reject(err || response.statusCode);
					}

					console.log('NestAccount: authentication revoked');

					return resolve();
				}
			);
		});
	}

	/**
	 * Listen for changes on devices objects in database. When a
	 * change occurs, update device in register.
	 * @private
	 */
	_listenForRealtimeUpdates() {
		return new Promise(resolve => {

			this.db.child('structures').on('value', snapshot => {
				this.registerStructures(snapshot);

				const promises = [];

				promises.push(
					new Promise(thermostatsResolve => {

						this.db.child('devices/thermostats').on('value', thermostatsSnapshot => {
							this.registerDevices(thermostatsSnapshot, 'thermostats');
							thermostatsResolve();
						});
					}),
					new Promise(smokeCOAlarmsResolve => {

						this.db.child('devices/smoke_co_alarms').on('value', smokeCOAlarmsSnapshot => {
							this.registerDevices(smokeCOAlarmsSnapshot, 'smoke_co_alarms');
							smokeCOAlarmsResolve();
						});
					}),
					new Promise(camerasResolve => {

						this.db.child('devices/cameras').on('value', camerasSnapshot => {
							this.registerDevices(camerasSnapshot, 'cameras');
							camerasResolve();
						});
					})
				);

				Promise.all(promises).then(() => {
					resolve();
				});
			});
		});
	}

	/**
	 * Registers devices in the register, if already present it will replace
	 * it with updated data. This makes sure that the device registers
	 * always have all the devices in the API registered and
	 * up-to-date.
	 * @param snapshot
	 * @param deviceType
	 */
	registerDevices(snapshot, deviceType) {
		const devices = snapshot.val();
		if (devices) {

			// Loop over all devices in devices object
			_.forEach(devices, device => {

				// Extract single device
				device = snapshot.child(device.device_id).val();

				// Do not continue if device is invalid
				if (!device || !device.device_id || !device.name_long || !device.structure_id) return false;

				// Check if device is already registered
				if (_.findWhere(this[deviceType], { device_id: device.device_id })) {

					// Remove device from array
					this[deviceType] = this[deviceType].filter(storedDevice => storedDevice.device_id !== device.device_id);
				}

				// Add device to its array
				this[deviceType].push({
					device_id: device.device_id,
					name_long: device.name_long,
					structure: _.findWhere(this.structures, { structure_id: device.structure_id }),
					nest_account: this
				});
			});
		}
	}

	/**
	 * Registers structures in the register, if already present it will replace
	 * it with updated data. This makes sure that the structures register
	 * always have all the structures in the API registered and
	 * up-to-date.
	 * @param snapshot
	 */
	registerStructures(snapshot) {
		const structures = snapshot.val();
		if (structures) {

			// Loop over all structure in structure object
			_.forEach(structures, structure => {

				// Extract single structure
				structure = snapshot.child(structure.structure_id).val();

				// Check if device is already registered
				if (_.findWhere(this.structures, { structure_id: structure.structure_id })) {

					// Remove device from array
					this.structures = this.structures.filter(storedStructure => storedStructure.structure_id !== structure.structure_id);
				}

				// Add structure to its array
				this.structures.push({
					away: structure.away,
					name: structure.name,
					structure_id: structure.structure_id
				});
			});
		}
	}

	/**
	 * Factory method to return NestThermostat instance.
	 * @param deviceId
	 * @returns {NestThermostat}
	 */
	createThermostat(deviceId) {
		return new NestThermostat(_.findWhere(this.thermostats, { device_id: deviceId }));
	}

	/**
	 * Factory method to return NestProtect instance.
	 * @param deviceId
	 * @returns {NestThermostat}
	 */
	createProtect(deviceId) {
		return new NestProtect(_.findWhere(this.smoke_co_alarms, { device_id: deviceId }));
	}

	/**
	 * Factory method to return NestCamera instance.
	 * @param deviceId
	 * @returns {NestThermostat}
	 */
	createCamera(deviceId) {
		return new NestCamera(_.findWhere(this.cameras, { device_id: deviceId }));
	}
}

/**
 * Abstract class that handles all common functionality
 * for the NestThermostat, NestProtect and NestCamera.
 * It will listen for updates on the device, and call
 * the child's checkForChanges method to register changes
 * in data.
 */
class NestDevice extends EventEmitter {

	/**
	 * Creates a Nest device and starts listening
	 * for updates from the realtime database.
	 * Provide options object with device_id, device_type
	 * and db reference.
	 * @param options
	 */
	constructor(options) {
		super();

		// Check for valid options
		if (!options || !options.device_id || !options.device_type || !options.nest_account || !options.nest_account.db) {
			return console.error(options, 'NestDevice: could not construct NestDevice, invalid options object provided to constructor');
		}

		// Store provided options in this
		Object.assign(this, options);

		// Start listening for updates on this device
		this._listenForRealtimeUpdates();
	}

	/**
	 * Listen for realtime updates from database.
	 * Call child's checkForChanges method with updated
	 * data to let it detect changes in data.
	 * @private
	 */
	_listenForRealtimeUpdates() {

		// Authenticate
		this.nest_account.authenticate().then(() => {

			// Listen for changes on this specific device
			this.nest_account.db.child(`devices/${this.device_type}`).child(this.device_id).on('value', snapshot => {

				// First process changes
				this.checkForChanges(snapshot.val());
			});
		});
	}

	/**
	 * Check incoming data update for changed values,
	 * emit corresponding events when data is changed.
	 * @param data
	 */
	checkForChanges(data) {

		// Check if capabilities are set
		if (this.capabilities) {

			// Loop all registered capabilities
			this.capabilities.forEach(capability => {

				// Detect change in value and emit it
				if (typeof this[capability] !== 'undefined' &&
					typeof data.hasOwnProperty(capability) !== 'undefined' &&
					this[capability] !== data[capability]) {

					// Emit change
					this.emit(capability, data[capability]);
				}
			});

			// Assign all values from snapshot to this instance
			Object.assign(this, data);
		}
	}
}

/**
 * Class representing NestThermostat, extends
 * NestDevice.
 */
class NestThermostat extends NestDevice {

	/**
	 * Pass options object to NestDevice.
	 * @param options
	 */
	constructor(options) {

		// Set proper device type
		if (options) options.device_type = 'thermostats';

		super(options);

		// Store capabilities of thermostat
		this.capabilities = ['target_temperature_c', 'ambient_temperature_c', 'hvac_state'];
	}

	/**
	 * Set the target temperature of this Nest Thermostat.
	 * @param temperature in Celsius
	 */
	setTargetTemperature(temperature) {
		return new Promise((resolve, reject) => {

			// Authenticate
			this.nest_account.authenticate().then(() => {

				// Handle cases where temperature could not be set
				if (this.is_using_emergency_heat) return reject('NestThermostat: can not adjust target temperature while using emergency heat');
				if (this.is_locked) return reject(`NestThermostat: can not adjust target temperature outside locked range: ${this.locked_temp_min_c} - ${this.locked_temp_max_c}`);
				if (this.structure.away !== 'home') return reject(`NestThermostat: can not adjust target temperature when structure status is set to ${this.structure.away}`)
				if (this.hvac_mode === 'heat-cool') return reject('NestThermostat: can not adjust target temperature when hvac_mode is heat-cool');

				// All clear to change the target temperature
				this.nest_account.db.child(`devices/thermostats/${this.device_id}/target_temperature_c`).set(temperature);

				return resolve(temperature);
			}).catch(err => console.error(err));
		});
	}
}

/**
 * Class representing NestProtect, extends
 * NestDevice.
 */
class NestProtect extends NestDevice {

	/**
	 * Pass options object to NestDevice.
	 * @param options
	 */
	constructor(options) {

		// Set proper device type
		if (options) options.device_type = 'smoke_co_alarms';

		super(options);

		// Store capabilities of protect
		this.capabilities = ['battery_health', 'co_alarm_state', 'smoke_alarm_state'];
	}
}

/**
 * Class representing NestCamera, extends
 * NestDevice.
 */
class NestCamera extends NestDevice {

	/**
	 * Pass options object to NestDevice.
	 * @param options
	 */
	constructor(options) {

		// Set proper device type
		if (options) options.device_type = 'cameras';

		super(options);

		// Store capabilities of camera
		this.capabilities = ['last_event', 'is_streaming'];
	}

	/**
	 * Set streaming capability of camera.
	 * @param onoff Boolean
	 */
	setStreaming(onoff) {

		// Authenticate
		this.nest_account.authenticate().then(() => {

			if (typeof onoff !== 'boolean') console.error('NestCamera: setStreaming parameter "onoff" is not a boolean', onoff);

			// All clear to change the target temperature
			this.nest_account.db.child(`devices/cameras/${this.device_id}/is_streaming`).set(onoff);
		});
	}
}

module.exports = { NestAccount, NestThermostat, NestProtect, NestCamera };
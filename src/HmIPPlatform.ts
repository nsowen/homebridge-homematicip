import {
    API,
    Characteristic,
    DynamicPlatformPlugin,
    Logger,
    PlatformAccessory,
    PlatformConfig,
    Service
} from 'homebridge';
import {HmIPConnector} from "./HmIPConnector";
import {PLATFORM_NAME, PLUGIN_NAME} from "./settings";
import {
    HmIPDevice,
    HmIPGroup,
    HmIPHome,
    HmIPState,
    HmIPStateChange,
    Updateable
} from "./HmIPState";
import {HmIPShutter} from "./devices/HmIPShutter";
import {HmIPThermostat} from "./devices/HmIPThermostat";
import {HmIPHomeControlAccessPoint} from "./devices/HmIPHomeControlAccessPoint";
import {HmIPGenericDevice} from "./devices/HmIPGenericDevice";
import {HmIPWeatherDevice} from "./devices/HmIPWeatherDevice";
import {HmIPAccessory} from "./HmIPAccessory";

/**
 * HomematicIP platform
 */
export class HmIPPlatform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service = this.api.hap.Service;
    public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

    // this is used to track restored cached accessories
    public readonly accessories: PlatformAccessory[] = [];

    public readonly connector: HmIPConnector;
    public groups!: { [key: string]: HmIPGroup }
    private home!: HmIPHome;
    private deviceMap = new Map();

    constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: API,
    ) {
        this.connector = new HmIPConnector(
            log,
            config["access_point"],
            config["auth_token"]
        );

        this.log.debug('Finished initializing platform:', this.config.name);
        this.api.on('didFinishLaunching', () => {
            log.debug('Executed didFinishLaunching callback');
            this.discoverDevices();
        });
        this.api.on('shutdown', () => {
            log.debug('Executed shutdown callback');
            this.connector.disconnectWs();
        });
    }

    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory: PlatformAccessory) {
        if (!this.getAccessory(accessory.UUID)) {
            this.log.info('Loading accessory from cache:', accessory.displayName);
            this.accessories.push(accessory);
        }
    }

    /**
     * This is an example method showing how to register discovered accessories.
     * Accessories must only be registered once, previously created accessories
     * must not be registered again to prevent "duplicate UUID" errors.
     */
    async discoverDevices() {
        if (!(await this.connector.init()).valueOf()) {
            return;
        }

        const hmIPState = <HmIPState> await this.connector.apiCall("home/getCurrentState");
        this.groups = hmIPState.groups;
        this.setHome(hmIPState.home);

        // loop over the discovered devices and register each one if it has not already been registered
        for (const id in hmIPState.devices) {
            const device = hmIPState.devices[id];
            this.updateAccessory(id, this.home, device);
        }

        await this.connector.connectWs( data => {
            const stateChange = <HmIPStateChange> JSON.parse(data.toString());
            for (const id in stateChange.events) {
                const event = stateChange.events[id];
                switch (event.pushEventType) {
                    case 'GROUP_CHANGED':
                    case 'GROUP_ADDED':
                        if (event.group) {
                            this.log.debug(`${event.pushEventType}: ${event.group.id}`);
                            hmIPState.groups[event.group.id] = event.group;
                            this.groups[event.group.id] = event.group;
                        }
                        break;
                    case 'GROUP_REMOVED':
                        if (event.group) {
                            this.log.debug(`${event.pushEventType}: ${event.group.id}`);
                            delete hmIPState.groups[event.group.id];
                            delete this.groups[event.group.id];
                        }
                        break;
                    case 'DEVICE_REMOVED':
                        if (event.device) {
                            this.log.debug(`${event.pushEventType}: ${event.device.id} ${event.device.modelType}`);
                            const hmIPDevice: HmIPGenericDevice | null = this.deviceMap.get(event.device.id);
                            if (hmIPDevice) {
                                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [hmIPDevice.accessory])
                                delete hmIPState.devices[event.device.id];
                                this.deviceMap.delete(event.device.id);
                            } else {
                                this.log.warn("Cannot find device: " + event.device.id)
                            }
                        }
                        break;
                    case 'DEVICE_CHANGED':
                    case 'DEVICE_ADDED':
                        if (event.device) {
                            this.log.debug(`${event.pushEventType}: ${event.device.id} ${event.device.modelType}`);
                            if (this.deviceMap.has(event.device.id)) {
                                (<Updateable> this.deviceMap.get(event.device.id)).updateDevice(this.home, event.device, this.groups);
                            } else {
                                this.log.warn("Cannot find device: " + event.device.id)
                            }
                        }
                        break;
                    case 'HOME_CHANGED':
                        if (event.home) {
                            this.log.debug(`${event.pushEventType}: ${event.home.id} ${JSON.stringify(event.home)}`);
                            this.setHome(event.home);
                            this.deviceMap.forEach(device => {
                                device.home = event.home;
                                device.updateDevice(device, this.groups);
                            });
                        }
                        break;
                    default:
                        this.log.debug(`Unhandled event type: ${event.pushEventType} group=${event.group} device=${event.device}`);
                }
            }
        });
    }

    private setHome(home: HmIPHome) {
        home.oem = 'eQ-3';
        home.modelType = 'HmIPHome';
        home.firmwareVersion = home.currentAPVersion;
        this.updateHomeAccessories(home);
    }

    private updateAccessory(id: string, home: HmIPHome, device: HmIPDevice) {
        const uuid = this.api.hap.uuid.generate(id);
        const hmIPAccessory = this.createAccessory(uuid, device.label, device);
        var homebridgeDevice: HmIPGenericDevice | null = null;
        if (device.type === 'WALL_MOUNTED_THERMOSTAT_PRO') {
            homebridgeDevice = new HmIPThermostat(this, home, hmIPAccessory.accessory);
        } else if (device.type === 'FULL_FLUSH_SHUTTER') {
            homebridgeDevice = new HmIPShutter(this, home, hmIPAccessory.accessory);
        } else if (device.type === 'HOME_CONTROL_ACCESS_POINT') {
            this.log.debug("Creating: " + JSON.stringify(device));
            homebridgeDevice = new HmIPHomeControlAccessPoint(this, home, hmIPAccessory.accessory);
        } else {
            this.log.warn(`Device not implemented: ${device.modelType} - ${device.label}`);
            return;
        }
        this.deviceMap.set(id, homebridgeDevice);
        hmIPAccessory.register();
    }

    private updateHomeAccessories(home: HmIPHome) {
        //this.updateHomeWeatherAccessory(home);
    }

    private updateHomeWeatherAccessory(homeOriginal: HmIPHome) {
        let home = Object.assign({}, homeOriginal);
        home.id = home.id + '__weather';
        const uuid = this.api.hap.uuid.generate(home.id);
        const hmIPAccessory = this.createAccessory(uuid, 'HmIPWeather', home);
        var homeBridgeDevice = new HmIPWeatherDevice(this, home, hmIPAccessory.accessory);
        this.deviceMap.set(home.id, homeBridgeDevice);
        hmIPAccessory.register();
    }

    private createAccessory(uuid: string, displayName: string, deviceContext: any) : HmIPAccessory {
        // see if an accessory with the same uuid has already been registered and restored from
        // the cached devices we stored in the `configureAccessory` method above
        var existingAccessory = this.getAccessory(uuid);
        if (!existingAccessory) {
            this.log.debug("Could not find existing accessory in pool: " + this.accessories.map(val => val).join(', '));
        }
        var accessory = existingAccessory ? existingAccessory :  new this.api.platformAccessory(displayName, uuid);
        accessory.context.device = deviceContext;
        return new HmIPAccessory(this.api, this.log, accessory, existingAccessory != null);
    }

    private getAccessory(uuid: string) : PlatformAccessory | undefined {
        return this.accessories.find(accessoryFound => accessoryFound.UUID === uuid);
    }

}

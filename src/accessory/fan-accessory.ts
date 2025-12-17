import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { flow, identity, pipe } from 'fp-ts/lib/function';
import { CharacteristicValue, Service } from 'homebridge';
import { SupportedActionsType } from '../domain/alexa';
import { FanState } from '../domain/alexa/fan';
import * as mapper from '../mapper/fan-mapper';
import BaseAccessory from './base-accessory';

export default class FanAccessory extends BaseAccessory {
  static requiredOperations: SupportedActionsType[] = ['turnOn', 'turnOff'];
  service: Service;
  isExternalAccessory = false;

  configureServices() {
    this.service =
      this.platformAcc.getService(this.Service.Fanv2) ||
      this.platformAcc.addService(this.Service.Fanv2, this.device.displayName);

    this.service
      .getCharacteristic(this.Characteristic.Active)
      .onGet(this.handleActiveGet.bind(this))
      .onSet(this.handleActiveSet.bind(this));

    if (
      this.device.supportedOperations.includes('setPercentage') ||
      this.device.supportedOperations.includes('adjustPercentage') ||
      this.device.supportedOperations.includes('rampPercentage')
    ) {
      this.service
        .getCharacteristic(this.Characteristic.RotationSpeed)
        .onGet(this.handleRotationSpeedGet.bind(this))
        .onSet(this.handleRotationSpeedSet.bind(this));
    }
  }

  async handleActiveGet(): Promise<boolean> {
    const determinePowerState = flow(
      A.findFirst<FanState>(({ featureName }) => featureName === 'power'),
      O.tap(({ value }) =>
        O.of(this.logWithContext('debug', `Get power result: ${value}`)),
      ),
      O.map(({ value }) => value === 'ON'),
    );

    return pipe(
      this.getStateGraphQl(determinePowerState),
      TE.match((e) => {
        this.logWithContext('errorT', 'Get power', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  async handleActiveSet(value: CharacteristicValue): Promise<void> {
    this.logWithContext('debug', `Triggered set power: ${value}`);
    if (typeof value !== 'number') {
      throw this.invalidValueError;
    }
    const action = mapper.mapHomeKitPowerToAlexaAction(
      value,
      this.Characteristic,
    );
    return pipe(
      this.platform.alexaApi.setDeviceStateGraphQl(
        this.device.endpointId,
        'power',
        action,
      ),
      TE.match(
        (e) => {
          this.logWithContext('errorT', 'Set power', e);
          throw this.serviceCommunicationError;
        },
        () => {
          this.updateCacheValue({
            value: mapper.mapHomeKitPowerToAlexaValue(
              value,
              this.Characteristic,
            ),
            featureName: 'power',
          });
        },
      ),
    )();
  }

  async handleRotationSpeedGet(): Promise<number> {
    const determinePercentageState = flow(
      A.findFirst<FanState>(({ featureName }) => featureName === 'percentage'),
      O.flatMap(({ value }) => {
        if (typeof value === 'number') {
          return O.of(value);
        }
        if (typeof value === 'string') {
          const parsed = parseFloat(value);
          return isNaN(parsed) ? O.none : O.of(parsed);
        }
        return O.none;
      }),
      O.tap((s) =>
        O.of(this.logWithContext('debug', `Get rotation speed result: ${s}%`)),
      ),
    );

    return pipe(
      this.getStateGraphQl(determinePercentageState),
      TE.match((e) => {
        this.logWithContext('errorT', 'Get rotation speed', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  async handleRotationSpeedSet(value: CharacteristicValue): Promise<void> {
    this.logWithContext('debug', `Triggered set rotation speed: ${value}`);
    if (typeof value !== 'number') {
      throw this.invalidValueError;
    }

    // Clamp value to 0-100 range
    const clampedValue = Math.max(0, Math.min(100, value));
    const percentageValue = clampedValue.toString(10);

    // Determine which action to use based on device capabilities
    // Prefer setPercentage, then adjustPercentage, then rampPercentage
    let action: SupportedActionsType;
    if (this.device.supportedOperations.includes('setPercentage')) {
      action = 'setPercentage';
    } else if (this.device.supportedOperations.includes('adjustPercentage')) {
      action = 'adjustPercentage';
    } else if (this.device.supportedOperations.includes('rampPercentage')) {
      action = 'rampPercentage';
    } else {
      throw this.invalidValueError;
    }

    return pipe(
      this.platform.alexaApi.setDeviceStateGraphQl(
        this.device.endpointId,
        'percentage',
        action,
        {
          percentage: percentageValue,
        },
      ),
      TE.match(
        (e) => {
          this.logWithContext('errorT', 'Set rotation speed', e);
          throw this.serviceCommunicationError;
        },
        () => {
          this.updateCacheValue({
            value: percentageValue,
            featureName: 'percentage',
          });
        },
      ),
    )();
  }
}

import fnis, { fnisTool, fnisDataMod, calcChecksum } from './fnis';
import { nexusPageURL, isSupported } from './gameSupport';
import reducer from './reducers';
import Settings from './Settings';
import { IDeployment } from './types';

import * as Promise from 'bluebird';
import * as I18next from 'i18next';
import { actions, types, selectors, util } from 'vortex-api';
import { setAutoFNIS } from './actions';

interface IFNISProps {
  gameMode: string;
  enabled: boolean;
}

function autoFNIS(state: types.IState): boolean {
  return util.getSafe(state, ['settings', 'automation', 'autoFNIS'], false);
}

function toggleIntegration(api: types.IExtensionApi, gameMode: string) {
  const state: types.IState = api.store.getState();
  api.store.dispatch(setAutoFNIS(!autoFNIS(state)));
}

function init(context: types.IExtensionContext) {
  (context.registerSettings as any)('Interface', Settings, undefined, undefined, 51);
  context.registerReducer(['settings', 'automation'], reducer);
  context.registerToDo(
    'fnis-integration', 'settings',
    (state: types.IState): IFNISProps => {
      const gameMode = selectors.activeGameId(state);
      return {
        gameMode,
        enabled: autoFNIS(state),
      };
    }, 'download',
    'FNIS Integration', (props: IFNISProps) => toggleIntegration(context.api, props.gameMode),
    (props: IFNISProps) => isSupported(props.gameMode),
    (t: I18next.TranslationFunction, props: IFNISProps) => (
      props.enabled ? t('Yes') : t('No')
    ),
    undefined,
  );

  context.registerAction('mod-icons', 300, 'refresh', {}, 'Configure FNIS', () => {
    const state = context.api.store.getState();
    const profile = selectors.activeProfile(state);
    fnis(context.api, profile, true);
  });

  context.registerTest('fnis-integration', 'gamemode-activated', (): Promise<types.ITestResult> => {
    const t = context.api.translate;
    const state: types.IState = context.api.store.getState();
    const gameMode = selectors.activeGameId(state);
    const tool = fnisTool(state, gameMode);
    if (tool !== undefined) {
      return Promise.resolve(undefined);
    }
    const res: types.ITestResult = {
      severity: 'warning',
      description: {
        short: t('FNIS not installed'),
        long: t('You have configured FNIS to be run automatically but it\'s not installed for this game. '
            + 'For the automation to work, FNIS has to be installed and configured for the current game. '
            + 'You can press "Fix" to take you to the FNIS download page, then you have to install and '
            + 'configure it manually.'),
      },
      automaticFix: () => (util as any).opn(nexusPageURL(gameMode)),
    };

    return Promise.resolve(res);
  });

  context.once(() => {
    let lastChecksum: string;
    (context.api as any).onAsync('will-deploy', (deployment: IDeployment) => {
      lastChecksum = undefined;
      const state = context.api.store.getState();

      if (util.getSafe(state, ['settings', 'automation', 'autoFNIS'], false)) {
        const profile = selectors.activeProfile(state);
        context.api.store.dispatch(actions.setModEnabled(profile.id, fnisDataMod(profile.name), false));
        const discovery: types.IDiscoveryResult = state.settings.gameMode.discovered[profile.gameId];
        if ((discovery === undefined) || (discovery.path === undefined)) {
          return Promise.resolve();
        }

        return calcChecksum(discovery.path, deployment)
          .then(checksum => {
            lastChecksum = checksum;
          });
      } else {
        return Promise.resolve();
      }
    });
    (context.api as any).onAsync('did-deploy', (deployment: IDeployment, setTitle: (title: string) => void) => {
      const state = context.api.store.getState();
      if (lastChecksum !== undefined) {
        const profile = selectors.activeProfile(state);
        const discovery: types.IDiscoveryResult = state.settings.gameMode.discovered[profile.gameId];
        const modId = fnisDataMod(profile.name);
        return calcChecksum(discovery.path, deployment)
          .then(checksum => {
            console.log('checksums', lastChecksum, checksum);
            if (checksum === lastChecksum) {
              return Promise.resolve();
            }

            setTitle(context.api.translate('Updating FNIS'));
            return Promise.resolve(fnis(context.api, profile, false));
          })
          .then(() => {
            context.api.store.dispatch(actions.setModEnabled(profile.id, modId, true));
            return (context.api as any).emitAndAwait('deploy-single-mod', profile.gameId, modId);
          });
      } else {
        return Promise.resolve();
      }
    });
  });
}

export default init;

import fnis, { fnisTool, fnisDataMod, calcChecksum, readFNISPatches } from './fnis';
import { nexusPageURL, isSupported } from './gameSupport';
import reducer from './reducers';
import Settings from './Settings';
import { IDeployment } from './types';

import * as Promise from 'bluebird';
import * as I18next from 'i18next';
import { actions, types, selectors, util } from 'vortex-api';
import { setAutoRun, setPatches, setNeedToRun } from './actions';

interface IFNISProps {
  gameMode: string;
  enabled: boolean;
}

function autoRun(state: types.IState): boolean {
  return util.getSafe(state, ['settings', 'automation', 'autoRun'], false);
}

function toggleIntegration(api: types.IExtensionApi, gameMode: string) {
  const state: types.IState = api.store.getState();
  api.store.dispatch(setAutoRun(!autoRun(state)));
}

function init(context: types.IExtensionContext) {
  (context.registerSettings as any)('Interface', Settings, undefined, undefined, 51);
  context.registerReducer(['settings', 'fnis'], reducer);
  context.registerToDo(
    'fnis-integration', 'settings',
    (state: types.IState): IFNISProps => {
      const gameMode = selectors.activeGameId(state);
      return {
        gameMode,
        enabled: autoRun(state),
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
    const enabledPatches = new Set<string>(
      util.getSafe(state, ['settings', 'fnis', 'patches', profile.id], []));
    readFNISPatches(context.api, profile)
    .then(patches => {
      return context.api.showDialog('question', 'Select patches for this profile', {
        text: 'Please select the patches to activate in FNIS.\n'
            + 'Only select patches you have the corresponding mod for!\n'
            + 'This list is stored separately for each profile.',
        checkboxes: patches.map(patch => ({
          id: patch.id,
          text: patch.description,
          value: enabledPatches.has(patch.id),
        })),
      }, [
        { label: 'Cancel' },
        { label: 'Save' },
      ]);
    })
    .then((result: types.IDialogResult) => {
      if (result.action === 'Save') {
        context.api.store.dispatch(setPatches(profile.id,
          Object.keys(result.input).filter(patch => result.input[patch])));
        context.api.store.dispatch(setNeedToRun(profile.id, true));
      }
    });
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

      if (util.getSafe(state, ['settings', 'fnis', 'autoRun'], false)) {
        const profile = selectors.activeProfile(state);
        if (profile === undefined) {
          return;
        }
        const modId = fnisDataMod(profile.name);
        if (!util.getSafe(profile, ['modState', modId, 'enabled'], true)) {
          // if the data mod is known but disabled, don't update it and most importantly:
          //  don't activate it after deployment, that's probably not what the user wants
          return;
        }
        context.api.store.dispatch(actions.setModEnabled(profile.id, modId, false));
        context.api.store.dispatch((actions as any).clearModRules(profile.gameId, modId));
        const discovery: types.IDiscoveryResult = state.settings.gameMode.discovered[profile.gameId];
        if ((discovery === undefined) || (discovery.path === undefined)) {
          return Promise.resolve();
        }

        return calcChecksum(discovery.path, deployment)
          .then(({checksum, mods}) => {
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
        const allMods = state.persistent.mods[profile.gameId];
        return calcChecksum(discovery.path, deployment)
          .then(({ checksum, mods }) => {
            mods.forEach(refId => {
              context.api.store.dispatch(actions.addModRule(profile.gameId, modId, {
                type: 'after',
                reference: { id: refId },
              }));
            });
            if ((checksum === lastChecksum)
                && (allMods[modId] !== undefined)
                && !util.getSafe(state, ['settings', 'fnis', 'needToRun', profile.id], false)) {
              return Promise.resolve();
            }

            setTitle(context.api.translate('Updating FNIS'));
            return Promise.resolve(fnis(context.api, profile, false));
          })
          .then(() => {
            context.api.store.dispatch(actions.setModEnabled(profile.id, modId, true));
            context.api.store.dispatch(setNeedToRun(profile.id, false));
            return (context.api as any).emitAndAwait('deploy-single-mod', profile.gameId, modId);
          });
      } else {
        return Promise.resolve();
      }
    });
  });
}

export default init;

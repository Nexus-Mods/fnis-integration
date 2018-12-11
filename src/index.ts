import { setAutoRun, setPatches, setNeedToRun } from './actions';
import fnis, { fnisTool, fnisDataMod, calcChecksum, readFNISPatches } from './fnis';
import { nexusPageURL, isSupported } from './gameSupport';
import reducer from './reducers';
import Settings from './Settings';
import { IDeployment } from './types';

import * as Promise from 'bluebird';
import getVersion from 'exe-version';
import * as I18next from 'i18next';
import { actions, fs, log, types, selectors, util } from 'vortex-api';

interface IFNISProps {
  gameMode: string;
  enabled: boolean;
}

function autoRun(state: types.IState): boolean {
  return util.getSafe(state, ['settings', 'fnis', 'autoRun'], false);
}

function toggleIntegration(api: types.IExtensionApi, gameMode: string) {
  const state: types.IState = api.store.getState();
  api.store.dispatch(setAutoRun(!autoRun(state)));
}

function checkFailedResult(t: I18next.TranslationFunction,
                           gameMode: string,
                           reason: 'missing' | 'outdated'): types.ITestResult {
  const short = {
    missing: t('FNIS not installed'),
    outdated: t('FNIS outdated'),
  }[reason];

  const long = {
    missing: t('You have configured Vortex to run FNIS automatically but it\'s not installed for this game. '
              + 'For the automation to work, FNIS has to be installed and configured for the current game. '
              + 'You can download it from [url]{{url}}[/url].', { replace: { url: nexusPageURL(gameMode) } }),
    outdated: t('You have configured Vortex to run FNIS automatically but the installed version of FNIS is '
                + 'too old and doesn\'t support being embedded. Please download and install at least '
                + 'version 7.4 from [url]{{url}}[/url].', { replace: { url: nexusPageURL(gameMode) } }),
  }[reason];

  const res: types.ITestResult = {
    severity: 'warning',
    description: {
      short,
      long,
    },
  };
  return res;
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

  context.registerAction('mod-icons', 300, 'settings', {}, 'Configure FNIS', () => {
    const state = context.api.store.getState();
    const profile = selectors.activeProfile(state);
    const enabledPatches = new Set<string>(
      util.getSafe(state, ['settings', 'fnis', 'patches', profile.id], []));
    readFNISPatches(context.api, profile)
    .then(patches => {
      return context.api.showDialog('question', 'Select patches for this profile', {
        text: 'Please select the patches to activate in FNIS (when run automatically!).\n'
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
    })
    .catch(err => {
      if (err instanceof util.ProcessCanceled) {
        return; 
      }
      context.api.showErrorNotification('Failed to read list of available patches', err);
    });
  }, () => isSupported(selectors.activeGameId(context.api.store.getState())));

  context.registerTest('fnis-integration', 'gamemode-activated', (): Promise<types.ITestResult> => {
    const t = context.api.translate;
    const state: types.IState = context.api.store.getState();
    if (!util.getSafe(state, ['settings', 'fnis', 'autoRun'], false)) {
      // not enabled
      return Promise.resolve(undefined);
    }
    const gameMode = selectors.activeGameId(state);
    if (!isSupported(gameMode)) {
      // game not supported
      return Promise.resolve(undefined);
    }
    const tool = fnisTool(state, gameMode);

    if (tool !== undefined) {
      // if the tool is configured, verify it's actually installed at that location
      return fs.statAsync(tool.path)
        .then(() => {
          const versionStr: string = getVersion(tool.path);
          if (versionStr === undefined) {
            return checkFailedResult(t, gameMode, 'missing');
          } else {
            const version = versionStr.split('.').map(seg => parseInt(seg, 10));
            if ((version[0] < 7)
                || ((version[0] === 7) && (version[1] < 4))) {
              return checkFailedResult(t, gameMode, 'outdated');
            }
          }
          return undefined;
        })
        .catch(() => checkFailedResult(t, gameMode, 'missing'));
    } else {
      return Promise.resolve(checkFailedResult(t, gameMode, 'missing'));
    }
  });

  context.once(() => {
    let lastChecksum: string;
    (context.api as any).onAsync('will-deploy', (profileId: string, deployment: IDeployment) => {
      lastChecksum = undefined;
      const state: types.IState = context.api.store.getState();

      if (util.getSafe(state, ['settings', 'fnis', 'autoRun'], false)) {
        const profile = state.persistent.profiles[profileId];
        if ((profile === undefined) || !isSupported(profile.gameId)) {
          return;
        }
        const modId = fnisDataMod(profile.name);
        if ((util.getSafe(state, ['mods', modId], undefined) !== undefined)
            && !util.getSafe(profile, ['modState', modId, 'enabled'], true)) {
          // if the data mod is known but disabled, don't update it and most importantly:
          //  don't activate it after deployment, that's probably not what the user wants
          return;
        }
        context.api.store.dispatch(actions.setModEnabled(profile.id, modId, false));
        const discovery: types.IDiscoveryResult = state.settings.gameMode.discovered[profile.gameId];
        if ((discovery === undefined) || (discovery.path === undefined)) {
          return Promise.resolve();
        }

        return calcChecksum(discovery.path, deployment)
          .then(({checksum, mods}) => {
            log('debug', 'Animations checksum calculated', checksum);
            lastChecksum = checksum;
          });
      } else {
        return Promise.resolve();
      }
    });
    (context.api as any).onAsync('did-deploy', (profileId: string, deployment: IDeployment, setTitle: (title: string) => void) => {
      const { store } = context.api;
      const state = store.getState();
      if (lastChecksum !== undefined) {
        const profile = state.persistent.profiles[profileId];
        if (profile === undefined) {
          // profile got deleted while deploying? Shouldn't have been possible
          return Promise.resolve();
        }
        const discovery: types.IDiscoveryResult = state.settings.gameMode.discovered[profile.gameId];
        const modId = fnisDataMod(profile.name);
        const allMods = state.persistent.mods[profile.gameId];
        // TODO: this is a hack. We don't want the FNIS Data mod being enabled to trigger a new deployment,
        //   but this is probably true for everything that runs as a post-deploy callback but _not_ for everything
        //   else that is triggered separately
        const didNeedDeployment = (state.persistent as any).deployment.needToDeploy[profile.gameId];
        return calcChecksum(discovery.path, deployment)
          .then(({ checksum, mods }) => {
            log('debug', 'Animations checksum after deployment', checksum);
            store.dispatch((actions as any).clearModRules(profile.gameId, modId));
            mods.forEach(refId => {
              store.dispatch(actions.addModRule(profile.gameId, modId, {
                type: 'after',
                reference: { id: refId },
              }));
            });
            if (!didNeedDeployment) {
              store.dispatch((actions as any).setDeploymentNecessary(profile.gameId, false));
            }
            if ((checksum === lastChecksum)
                && (allMods[modId] !== undefined)
                && !util.getSafe(state, ['settings', 'fnis', 'needToRun', profile.id], false)) {
              return Promise.resolve();
            }

            setTitle(context.api.translate('Updating FNIS'));
            return Promise.resolve(fnis(context.api, profile, false));
          })
          .then(() => {
            store.dispatch(actions.setModEnabled(profile.id, modId, true));
            store.dispatch(setNeedToRun(profile.id, false));
            return (context.api as any).emitAndAwait('deploy-single-mod', profile.gameId, modId);
          });
      } else {
        return Promise.resolve();
      }
    });
  });
}

export default init;

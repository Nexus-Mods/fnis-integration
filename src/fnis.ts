import { patchListName } from './gameSupport';
import { IDeployment, IFNISPatch } from './types';

import * as path from 'path';
import { actions, fs, selectors, types, util } from 'vortex-api';

export function fnisDataMod(profileName: string): string {
  return `FNIS Data (${profileName})`;
}

async function createFNISMod(api: types.IExtensionApi, modName: string, profile: types.IProfile): Promise<void> {
  const mod: types.IMod = {
    id: modName,
    state: 'installed',
    attributes: {
      name: 'FNIS Data',
      logicalFileName: 'FNIS Data',
      // concrete id doesn't really matter but needs to be set to for grouping
      modId: 42,
      version: '1.0.0',
      variant: profile.name,
      installTime: new Date(),
    },
    installationPath: modName,
    type: '',
  };

  await new Promise<void>((resolve, reject) => {
    api.events.emit('create-mod', profile.gameId, mod, async (error) => {
      if (error !== null) {
        return reject(error);
      }
      resolve();
    });
  });

  const state = api.store.getState();
  const installPath = (selectors as any).installPathForGame(state, profile.gameId);

  await fs.ensureFileAsync(path.join(installPath, modName, 'tools', 'GenerateFNIS_for_Users', 'MyPatches.txt'));
}

async function ensureFNISMod(api: types.IExtensionApi, profile: types.IProfile): Promise<string> {
  const state: types.IState = api.store.getState();
  const modName = fnisDataMod(profile.name);
  if (util.getSafe(state, ['persistent', 'mods', profile.gameId, modName], undefined) === undefined) {
    await createFNISMod(api, modName, profile);
  } else {
    // give the user an indication when this was last updated
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'installTime', new Date()));
    // the rest here is only required to update mods from previous vortex versions
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'name', 'FNIS Data'));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'logicalFileName', 'FNIS Data'));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'modId', 42));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'version', '1.0.0'));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'variant', profile.name));
  }
  return modName;
}

export function fileChecksum(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    try {
      const { createHash } = require('crypto');
      const hash = createHash('md5');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (data) => {
        hash.update(data);
      });
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

export function stringChecksum(data: string): string {
  const { createHash } = require('crypto');
  const hash = createHash('md5');
  hash.update(data);
  return hash.digest('hex');
}

const expressions = [
  new RegExp(/\\FNIS_.*_List\.txt$/i),
  new RegExp(/\\FNIS.*Behavior\.txt$/i),
  new RegExp(/\\PatchList\.txt$/i),
  new RegExp(/\\skeleton.*\.hkx$/i),
  new RegExp(/\\animations\\.*\.hkx$/i),
];

export async function calcChecksum(basePath: string,
                                   deployment: IDeployment): Promise<{ checksum: string, mods: string[] }> {
  const mods = new Set<string>();
  const animationFiles = deployment[''].filter((file: types.IDeployedFile) => {
    const res = expressions.find(expr => expr.test(file.relPath)) !== undefined;
    if (res) {
      mods.add(file.source);
    }
    return res;
  });

  const checksum = stringChecksum(JSON.stringify(animationFiles.map(async file => ({
      name: file.relPath,
      checksum: await fileChecksum(path.join(basePath, 'data', file.relPath)),
    }))));
  return { checksum, mods: Array.from(mods) };
}

export function fnisTool(state: types.IState, gameId: string): any {
  const tools: { [id: string]: any } = util.getSafe(state,
                            ['settings', 'gameMode', 'discovered', gameId, 'tools'], {});
  return Object.keys(tools).map(id => tools[id])
    .filter(iter => (iter !== undefined) && (iter.path !== undefined))
    .find(iter => 
      path.basename(iter.path).toLowerCase() === 'generatefnisforusers.exe'
    );
}

const patchTransform = [
  { key: 'id', transform: input => input },
  { key: 'hidden', transform: input => input === '1' },
  { key: 'numBones', transform: input => parseInt(input, 10) },
  { key: 'requiredBehaviorsPattern', transform: input => input },
  { key: 'description', transform: input => input },
  { key: 'requiredFile', transform: input => input },
];

export async function readFNISPatches(api: types.IExtensionApi, profile: types.IProfile): Promise<IFNISPatch[]> {
  const state: types.IState = api.store.getState();
  const tool = fnisTool(state, profile.gameId);
  if (tool === undefined) {
    return Promise.reject(new util.ProcessCanceled('FNIS not installed'));
  }
  try {
    const patchData = await fs.readFileAsync(
      path.join(path.dirname(tool.path), patchListName(profile.gameId)), { encoding: 'utf-8' });
    return patchData
      .split('\n')
      .slice(1)
      .filter(line => !line.startsWith('\'') && (line.trim().length > 0))
      .map(line => line.split('#').slice(0, 6).reduce((prev: any, value: string, idx: number) => {
        prev[patchTransform[idx].key] = patchTransform[idx].transform(value);
        return prev;
      }, []))
      .filter((patch: IFNISPatch) => !patch.hidden);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    } else {
      throw err;
    }
  }
}

async function writePatches(toolPath: string, patches: string[]) {
  const patchesPath = path.join(toolPath, 'MyPatches.txt');
  if (patches.length > 0) {
    await fs.writeFileAsync(patchesPath, patches.join('\n'), { encoding: 'utf-8' });
  } else {
    await fs.removeAsync(patchesPath);
  }
}

async function runFNIS(api: types.IExtensionApi, profile: types.IProfile, interactive: boolean): Promise<void> {
  const state: types.IState = api.store.getState();

  const tool = fnisTool(state, profile.gameId);
  if (tool === undefined) {
    return Promise.reject(new Error('FNIS not installed or not configured'));
  }

  await writePatches(path.dirname(tool.path), util.getSafe(state, ['settings', 'fnis', 'patches', profile.id], []));

  const installPath = (selectors as any).installPathForGame(state, profile.gameId);
  const modId = await ensureFNISMod(api, profile);
  const modPath = path.join(installPath, modId);
  const args = [ `RedirectFiles="${modPath}"` ];
  if (!interactive) {
    args.push('InstantExecute=1');
  }
  await api.runExecutable(tool.path, args, { suggestDeploy: false });
}

export default runFNIS;

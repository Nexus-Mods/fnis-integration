import { patchListName } from './gameSupport';
import { IDeployment, IFNISPatch } from './types';

import * as path from 'path';
import { actions, fs, log, selectors, types, util } from 'vortex-api';
import { GetProcessWindowList, SetForegroundWindow } from 'winapi-bindings';

// most of these are invalid on windows only but it's not worth the effort allowing them elsewhere
const INVALID_CHARS = /[:/\\*?"<>|]/g;

const CHECK_FOR_WINDOW_FREQUENCY = 1000; // ms

function sanitizeProfileName(input: string) {
  return input.replace(INVALID_CHARS, '_');
}

export function fnisDataMod(profileName: string): string {
  return `FNIS Data (${sanitizeProfileName(profileName)})`;
}

async function createFNISMod(api: types.IExtensionApi, modName: string,
                             profile: types.IProfile): Promise<void> {
  const mod: types.IMod = {
    id: modName,
    state: 'installed',
    attributes: {
      name: 'FNIS Data',
      logicalFileName: 'FNIS Data',
      // concrete id doesn't really matter but needs to be set to for grouping
      modId: 42,
      version: '1.0.0',
      variant: sanitizeProfileName(profile.name.replace(INVALID_CHARS, '_')),
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

  await fs.ensureFileAsync(path.join(installPath, modName, 'tools',
                                     'GenerateFNIS_for_Users', 'MyPatches.txt'));
}

async function ensureFNISMod(api: types.IExtensionApi, profile: types.IProfile): Promise<string> {
  const state: types.IState = api.store.getState();
  const modName = fnisDataMod(profile.name);
  if (util.getSafe(state, ['persistent', 'mods', profile.gameId, modName],
                   undefined) === undefined) {
    await createFNISMod(api, modName, profile);
  } else {
    // give the user an indication when this was last updated
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'installTime', new Date()));
    // the rest here is only required to update mods from previous vortex versions
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'name', 'FNIS Data'));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName,
                                               'logicalFileName', 'FNIS Data'));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'modId', 42));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'version', '1.0.0'));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'variant',
                                               sanitizeProfileName(profile.name)));
  }
  return modName;
}

export function fileChecksum(filePath: string): Promise<string> {
  const stackErr = new Error();
  return new Promise<string>((resolve, reject) => {
    try {
      const { createHash } = require('crypto');
      const hash = createHash('md5');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (data) => {
        hash.update(data);
      });
      stream.on('end', () => {
        stream.close();
        stream.destroy();
        return resolve(hash.digest('hex'));
      });
      stream.on('error', (err) => {
        err.stack = stackErr.stack;
        reject(err);
      });
    } catch (err) {
      err.stack = stackErr.stack;
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

class ConcurrencyLimit {
  private mLimit: number;
  private mNext: () => any;
  private mEndOfQueue: Promise<void>;
  constructor(limit: number) {
    this.mLimit = limit;
    this.mEndOfQueue = Promise.resolve();
  }

  public async do(cb: () => Promise<any>): Promise<any> {
    if (this.mLimit <= 0) {
      return this.enqueue(cb);
    }
    return this.process(cb);
  }

  private async process(cb: () => Promise<any>): Promise<any> {
    // reduce limit while processing
    --this.mLimit;
    try {
      // forward cb result
      return await cb();
    } catch (err) {
      return undefined;
    } finally {
      // increment limit again
      ++this.mLimit;
      // if there is something in the queue, process it
      if (this.mNext !== undefined) {
        this.mNext();
      }
    }
  }

  private enqueue(cb: () => Promise<any>): Promise<any> {
    return new Promise((outerResolve, outerReject) => {
      this.mEndOfQueue = this.mEndOfQueue
        .then(() => new Promise((resolve) => {
          // this pauses the queue until someone calls mNext
          this.mNext = resolve;
        })
        .then(() => {
          // once the queue is ticked, reset mNext in case there
          // is nothing else queued, then process the actual promise
          this.mNext = undefined;
          this.process(cb)
            .then(outerResolve)
            .catch(outerReject);
          // this resolves immediately, so the next promise in the queue
          // gets paused
        }));
    });
  }
}

export async function calcChecksum(basePath: string,
                                   deployment: IDeployment)
                                   : Promise<{ checksum: string, mods: string[] }> {
  const mods = new Set<string>();
  const animationFiles = deployment[''].filter((file: types.IDeployedFile) => {
    const res = expressions.find(expr => expr.test(file.relPath)) !== undefined;
    if (res) {
      mods.add(file.source);
    }
    return res;
  });

  log('debug', 'Files relevant for animation baking', animationFiles.length);
  const conlim = new ConcurrencyLimit(100);
  try {
    const checksum = stringChecksum(JSON.stringify(
      await Promise.all(animationFiles.map(async file => ({
        name: file.relPath,
        checksum: await conlim.do(async () => {
          try {
            return await fileChecksum(path.join(basePath, 'data', file.relPath));
          } catch (err) {
            return Promise.resolve('');
          }
        }),
      })))));
    return { checksum, mods: Array.from(mods) };
  } catch (err) {
    return undefined;
  }
}

export function fnisTool(state: types.IState, gameId: string): any {
  const tools: { [id: string]: any } = util.getSafe(state,
                            ['settings', 'gameMode', 'discovered', gameId, 'tools'], {});
  return Object.keys(tools).map(id => tools[id])
    .filter(iter => (iter !== undefined) && (iter.path !== undefined))
    .find(iter => path.basename(iter.path).toLowerCase() === 'generatefnisforusers.exe');
}

const patchTransform = [
  { key: 'id', transform: input => input },
  { key: 'hidden', transform: input => input === '1' },
  { key: 'numBones', transform: input => parseInt(input, 10) },
  { key: 'requiredBehaviorsPattern', transform: input => input },
  { key: 'description', transform: input => input },
  { key: 'requiredFile', transform: input => input },
];

export async function readFNISPatches(api: types.IExtensionApi,
                                      profile: types.IProfile): Promise<IFNISPatch[]> {
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
      .filter((patch: IFNISPatch) => !patch.hidden && (patch.numBones === 0));
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

function genSpawnedHandler(api: types.IExtensionApi) {
  if (process.platform !== 'win32') {
    // only supported on windows
    return;
  }

  return (pid?: number) => {
    if (pid === undefined) {
      return;
    }
    const checkTimeout = () => {
      try {
        process.kill(pid, 0);
        const hwnds = GetProcessWindowList(pid);
        if (hwnds.length > 0) {
          // if fnis has a window, something must have gone wrong. Ensure it's visible
          // otherwise the user may wait forever
          hwnds.forEach(hwnd => {
            SetForegroundWindow(hwnd);
          });
        } else {
          // fnis still running but has no window, check back later
          setTimeout(checkTimeout, CHECK_FOR_WINDOW_FREQUENCY);
        }
      } catch (err) {
        // if the kill throws an exception that means the process has ended. probably
      }
    };
    setTimeout(checkTimeout, CHECK_FOR_WINDOW_FREQUENCY);
  };
}

async function runFNIS(api: types.IExtensionApi, profile: types.IProfile,
                       interactive: boolean): Promise<void> {
  const state: types.IState = api.store.getState();

  const tool = fnisTool(state, profile.gameId);
  if (tool === undefined) {
    return Promise.reject(new util.SetupError('FNIS not installed or not configured correctly'));
  }

  const patches = util.getSafe(state, ['settings', 'fnis', 'patches', profile.id], []);
  await writePatches(path.dirname(tool.path), patches);

  const installPath = (selectors as any).installPathForGame(state, profile.gameId);
  const modId = await ensureFNISMod(api, profile);
  const modPath = path.join(installPath, modId);
  const args = [ `RedirectFiles="${modPath}"` ];
  if (!interactive) {
    args.push('InstantExecute=1');
  }
  await api.runExecutable(tool.path, args,
                          { suggestDeploy: false, onSpawned: genSpawnedHandler(api) as any });
}

export default runFNIS;

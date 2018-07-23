import * as actions from './actions';
import { types, util } from 'vortex-api';

/**
 * reducer for changes to ephemeral session state
 */
const settingsReducer: types.IReducerSpec = {
  reducers: {
    [actions.setAutoFNIS as any]: (state, payload) =>
      util.setSafe(state, ['autoFNIS'], payload),
  },
  defaults: {
    autoFNIS: true,
  },
};

export default settingsReducer;

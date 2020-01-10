import { setAutoRun } from './actions';

import I18next from 'i18next';
import * as React from 'react';
import { withTranslation } from 'react-i18next';
import { connect } from 'react-redux';
import * as Redux from 'redux';
import { ThunkDispatch } from 'redux-thunk';
import { Toggle, types } from 'vortex-api';

interface IBaseProps {
  t: typeof I18next.t;
}

interface IConnectedProps {
  autoRun: boolean;
}

interface IActionProps {
  onEnableautoRun: (enable: boolean) => void;
}

type IProps = IBaseProps & IConnectedProps & IActionProps;

function Settings(props: IProps) {
  const { t, autoRun, onEnableautoRun } = props;
  return (
    <div>
      <Toggle
        checked={autoRun}
        onToggle={onEnableautoRun}
      >
        {t('Run FNIS on Deployment Event')}
      </Toggle>
    </div>
  );
}

function mapStateToProps(state: any): IConnectedProps {
  return {
    autoRun: state.settings.fnis.autoRun,
  };
}

function mapDispatchToProps(dispatch: ThunkDispatch<types.IState, null, Redux.Action>): IActionProps {
  return {
    onEnableautoRun: (enable: boolean) => dispatch(setAutoRun(enable)),
  };
}

export default 
  withTranslation(['common', 'fnis-integration'])(
    connect(mapStateToProps, mapDispatchToProps)(
      Settings) as any) as React.ComponentClass<{}>;

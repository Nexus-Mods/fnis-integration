import { setAutoRun } from './actions';

import { TranslationFunction } from 'i18next';
import * as React from 'react';
import { translate } from 'react-i18next';
import { connect } from 'react-redux';
import { Toggle } from 'vortex-api';

interface IBaseProps {
  t: TranslationFunction;
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
        {t('Automatically run FNIS on every deployment')}
      </Toggle>
    </div>
  );
}

function mapStateToProps(state: any): IConnectedProps {
  return {
    autoRun: state.settings.fnis.autoRun,
  };
}

function mapDispatchToProps(dispatch: Redux.Dispatch<any>): IActionProps {
  return {
    onEnableautoRun: (enable: boolean) => dispatch(setAutoRun(enable)),
  };
}

export default 
  translate(['common', 'fnis-integration'], { wait: false })(
    connect(mapStateToProps, mapDispatchToProps)(
      Settings));

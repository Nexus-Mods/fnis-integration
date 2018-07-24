import { setAutoFNIS } from './actions';

import { TranslationFunction } from 'i18next';
import * as React from 'react';
import { translate } from 'react-i18next';
import { connect } from 'react-redux';
import { Toggle } from 'vortex-api';

interface IBaseProps {
  t: TranslationFunction;
}

interface IConnectedProps {
  autoFNIS: boolean;
}

interface IActionProps {
  onEnableAutoFNIS: (enable: boolean) => void;
}

type IProps = IBaseProps & IConnectedProps & IActionProps;

function Settings(props: IProps) {
  const { t, autoFNIS, onEnableAutoFNIS } = props;
  return (
    <div>
      <Toggle
        checked={autoFNIS}
        onToggle={onEnableAutoFNIS}
      >
        {t('Automatically run FNIS on every deployment')}
      </Toggle>
    </div>
  );
}

function mapStateToProps(state: any): IConnectedProps {
  return {
    autoFNIS: state.settings.automation.autoFNIS,
  };
}

function mapDispatchToProps(dispatch: Redux.Dispatch<any>): IActionProps {
  return {
    onEnableAutoFNIS: (enable: boolean) => dispatch(setAutoFNIS(enable)),
  };
}

export default 
  translate(['common', 'fnis-integration'], { wait: false })(
    connect(mapStateToProps, mapDispatchToProps)(
      Settings));

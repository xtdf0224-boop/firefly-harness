/* What the home page and the task list need to know about models: which ways are ready to use, and
   whether the desktop process has reported yet. */
import { useEffect, useMemo, useState } from 'react';
import { engineChoices } from '../../../state/models';
import { useApp } from '../../../state/store';

export function useChoices() {
  const models = useApp((s) => s.models);
  const choices = useMemo(() => engineChoices(models), [models]);
  return { models, choices };
}

/** False for a moment after launch, until the desktop process has said which API keys are saved; without
 *  this, people who do have a model would see 「先接入一个模型」 flash by on every start. */
export function useModelsKnown() {
  const known = useApp((s) => !s.models.desktop || s.models.workspaceRoot !== undefined);
  // If the bridge never answers, stop waiting and say so rather than staying blank.
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setLate(true), 3000);
    return () => window.clearTimeout(t);
  }, []);
  return known || late;
}

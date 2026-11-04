import { COMPANY_LAYER_STATUS_LABELS, type BusinessMapCompany, type BusinessMapCompanies, type CompanyLayerStatus, type CompanyLayerStatusCode } from '../../../../shared/analysis-contract/business-map-admin.ts';
import type { Layer } from '../../../../shared/analysis-contract/business-features.ts';

type CompanyState = Pick<BusinessMapCompany, 'dataEnabled' | 'task' | 'collection' | 'publication' | 'features'>;
type GenerationState = Pick<BusinessMapCompanies, 'automaticCollection' | 'generation'>;
const status = (code: CompanyLayerStatusCode): CompanyLayerStatus => ({ code, label: COMPANY_LAYER_STATUS_LABELS[code] });

function mapStatus(company: CompanyState, automatic: boolean): CompanyLayerStatus {
  if (!company.dataEnabled) return status('disabled');
  const { task, collection, publication } = company;
  if (task?.status === 'running' || task?.status === 'cancel_requested' || collection?.status === 'running') return status('running');
  if (!automatic) return status('paused');
  if (task?.status === 'queued' || collection?.status === 'queued' || collection?.status === 'retry') return status('queued');
  const taskCurrent = task && (!collection || task.updatedAt >= collection.updatedAt);
  if ((taskCurrent && task.status === 'failed') || collection?.status === 'unavailable' || collection?.status === 'failed' || publication.status === 'unavailable') return status('failed');
  if (taskCurrent && task.status === 'partial') return status('partial');
  if (publication.status === 'ready') return status(publication.outdated ? 'outdated' : 'ready');
  return status('pending');
}

function featureStatus(feature: BusinessMapCompany['features'][keyof BusinessMapCompany['features']], automatic: boolean): CompanyLayerStatus {
  if (feature.failure) return status('failed');
  if (!feature.on) return status('disabled');
  if (feature.run === 'running') return status('running');
  if (!automatic) return status('paused');
  if (feature.run === 'queued') return status('queued');
  return status(feature.publishedAt ? 'ready' : 'pending');
}

/** Live work takes priority over an older publication; an old failed task cannot override newer successful collection. */
export function companyLayerStatuses(company: CompanyState, settings: GenerationState): Record<Layer, CompanyLayerStatus> {
  return {
    map: mapStatus(company, settings.automaticCollection),
    filings: featureStatus(company.features.filings, settings.generation.filings),
    findings: featureStatus(company.features.findings, settings.generation.findings),
    tree: featureStatus(company.features.tree, settings.generation.tree),
    valuation: featureStatus(company.features.valuation, settings.generation.valuation),
  };
}

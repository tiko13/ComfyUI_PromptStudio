"""Versioned companion API with explicit startup publication.

No ComfyUI, torch, aiohttp, provider process, or routes import belongs here.
The host composition root publishes callbacks after creating its services.
"""
from dataclasses import dataclass
import sys
from types import ModuleType, MappingProxyType

API_VERSION = 1
CAPABILITIES = frozenset({"llm.generate", "llm.operation", "llm.status", "llm.abort", "llm.admission", "llm.shutdown"})
_HOLDER_NAME = "_promptstudio_product_services_v1"
_holder = sys.modules.setdefault(_HOLDER_NAME, ModuleType(_HOLDER_NAME))
if not hasattr(_holder, "service"): _holder.service = None


@dataclass(frozen=True)
class ProductServices:
    version: int
    capabilities: frozenset
    functions: object

    def __getattr__(self, name):
        try: return self.functions[name]
        except KeyError: raise AttributeError(name) from None


def publish_services(**functions):
    required = {"shared_llm_generate", "shared_llm_run", "shared_llm_status", "shared_llm_abort",
                "shared_llm_check_admission", "shared_llm_shutdown", "LlmOverloadedError"}
    missing = sorted(name for name in required if not callable(functions.get(name)))
    if missing: raise ValueError("Missing companion services: " + ", ".join(missing))
    capabilities = CAPABILITIES
    if all(callable(functions.get(name)) for name in ("shared_job_ledger", "shared_job_status")):
        capabilities = capabilities | {"jobs.activity"}
    service = ProductServices(API_VERSION, frozenset(capabilities), MappingProxyType(dict(functions)))
    _holder.service = service
    return service


def require_services(*, version=API_VERSION, capabilities=CAPABILITIES):
    service = _holder.service
    if service is None:
        raise RuntimeError("PromptStudio_Video requires ComfyUI_PromptStudio to finish startup. Install or update Prompt Studio, then restart ComfyUI.")
    if service.version != version or not set(capabilities).issubset(service.capabilities):
        raise RuntimeError("The Prompt Studio companion service API is incompatible. Update both studios together.")
    return service

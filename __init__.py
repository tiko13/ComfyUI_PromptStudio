from pathlib import Path

from .backend.runtime_storage import IMAGE_STATE, migrate_legacy_state

migrate_legacy_state(Path(__file__).resolve().parent, IMAGE_STATE)

from .backend.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .backend import routes  # noqa: F401
from .backend.product_services import publish_services
from .backend.job_observability import shared_job_ledger, shared_job_status
from .backend.job_routes import register_job_routes

publish_services(**{name: getattr(routes, name) for name in (
    "shared_llm_generate", "shared_llm_run", "shared_llm_status", "shared_llm_abort",
    "shared_llm_check_admission", "shared_llm_shutdown", "LlmOverloadedError",
)}, shared_job_ledger=shared_job_ledger, shared_job_status=shared_job_status)
register_job_routes(routes.PromptServer.instance)
from .backend import provenance_routes  # noqa: F401
from .backend.setup_routes import register_setup_routes
register_setup_routes(routes.PromptServer.instance)
from .backend.controlnet import register_controlnet_routes
register_controlnet_routes(routes.PromptServer.instance)

from .backend.lora_studio_bridge import register as register_lora_studio_bridge
register_lora_studio_bridge(routes.PromptServer.instance, NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS)

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

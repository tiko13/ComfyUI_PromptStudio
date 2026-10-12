import math
from pathlib import Path
import sys
import torch
from torch import nn
from torch.nn import functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.qwen_turbo import shifted_sigmas, _run_with_adapter
from backend.qwen_turbo import QwenImage21OfficialTurboSampler
from types import SimpleNamespace, ModuleType
from unittest.mock import patch

# Verify the schedule actually passed to ComfyUI, independent of resolution.
calls = []
class CaptureSampler:
    def sample(self, *args):
        calls.append(args)
        return args[-1], None

samplers = ModuleType('comfy.samplers')
samplers.sampler_object = lambda name: name
comfy = ModuleType('comfy')
comfy.samplers = samplers
custom = ModuleType('comfy_extras.nodes_custom_sampler')
custom.SamplerCustom = CaptureSampler
# Load PyTorch's lazy comparison dependencies before the temporary module map;
# restoring sys.modules must not cause native operators to register twice.
torch.testing.assert_close(torch.zeros(1), torch.zeros(1))
with patch.dict(sys.modules, {'comfy':comfy, 'comfy.samplers':samplers,
                             'comfy_extras.nodes_custom_sampler':custom}):
    model, positive = SimpleNamespace(model_options={}), object()
    for height, width in [(64,64), (128,128), (66,96)]:
        latent = {'samples':torch.zeros(1,4,height,width)}
        assert QwenImage21OfficialTurboSampler().sample(model, 123, positive, latent)[0] is latent
        args = calls[-1]
        assert args[:7] == (model, True, 123, 1.0, positive, positive, 'euler')
        torch.testing.assert_close(args[7], torch.tensor([1., .978453, .95418, .926626, .89508, .845148, .704534, .414568, 0.]), rtol=0, atol=0)
    try:
        QwenImage21OfficialTurboSampler().sample(SimpleNamespace(model_options={'promptstudio_qwen_turbo':'viggle-v0.3'}), 123, positive, latent)
    except ValueError:
        pass
    else:
        raise AssertionError('Official sampling must reject a stacked Viggle adapter')

torch.manual_seed(123)
for height, width in [(64, 64), (66, 96), (32, 48)]:
    mu = .5 + .4 * (height * width - 256) / (8192 - 256)
    t = torch.tensor([1, .9375, .875, .75, .5, .25], dtype=torch.float64)
    expected = torch.cat([math.exp(mu) / (math.exp(mu) + 1 / t - 1), torch.zeros(1)]).float()
    torch.testing.assert_close(torch.tensor(shifted_sigmas(height, width)), expected, rtol=0, atol=0)
    assert shifted_sigmas(height, width) == shifted_sigmas(height * 2, width * 2, 8)

class MLP(nn.Module):
    def __init__(self, fused):
        super().__init__()
        self.fused = fused
        self.gate_layer = nn.Linear(4, 6, bias=False)
        self.proj = nn.Linear(4, 6, bias=False)
        self.out = nn.Linear(6, 4, bias=False)
        self.gate_up = nn.Linear(4, 12, bias=False)
        self.gate_up.weight.data.copy_(torch.cat((self.gate_layer.weight, self.proj.weight)))

    def forward(self, x):
        if self.fused:
            gate, up = self.gate_up(x).chunk(2, -1)
            # Mimics the fused kernel bypassing out.forward.
            return F.linear(F.silu(gate) * up, self.out.weight)
        return self.out(F.silu(self.gate_layer(x)) * self.proj(x))

class Model(nn.Module):
    def __init__(self, fused):
        super().__init__()
        self.mlp = MLP(fused)
    def forward(self, x):
        return self.mlp(x)

class Executor:
    def __init__(self, model, fail=False):
        self.class_obj, self.fail = model, fail
    def __call__(self, x):
        if self.fail:
            raise RuntimeError('sample failed')
        return self.class_obj(x)

for fused in [False, True]:
    model = Model(fused)
    x = torch.randn(2, 3, 4)
    weights = {}
    effective = {}
    for leaf in ('gate_layer', 'proj', 'out'):
        weight = getattr(model.mlp, leaf).weight
        pair = (torch.randn(2, weight.shape[1]) * .1, torch.randn(weight.shape[0], 2) * .1)
        weights['mlp.' + leaf] = pair
        effective[leaf] = weight + pair[1] @ pair[0]
    expected = F.linear(F.silu(F.linear(x, effective['gate_layer'])) * F.linear(x, effective['proj']), effective['out'])
    baseline = model(x).detach().clone()
    for _ in range(2):
        torch.testing.assert_close(_run_with_adapter(weights, Executor(model), x), expected)
        torch.testing.assert_close(model(x), baseline, rtol=0, atol=0)
        assert all(not m._forward_hooks for m in model.modules())
    try:
        _run_with_adapter(weights, Executor(model, fail=True), x)
    except RuntimeError:
        pass
    else:
        raise AssertionError('Expected failure')
    assert all(not m._forward_hooks for m in model.modules())
    weights['missing.layer'] = next(iter(weights.values()))
    try:
        _run_with_adapter(weights, Executor(model), x)
    except AttributeError:
        pass
    else:
        raise AssertionError('Expected hook setup failure')
    assert all(not m._forward_hooks for m in model.modules())
print('Schedule, /8 latent sizing, fused/unfused LoRA equivalence and hook cleanup passed')

import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
import torch

ROOT=Path(__file__).resolve().parents[1]
package=types.ModuleType("region_composite_test");package.__path__=[str(ROOT)]
spec=importlib.util.spec_from_file_location(package.__name__+".reference_regions",ROOT/"reference_regions.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class CompositeTests(unittest.TestCase):
    def test_pixel_preservation_alpha_source_change_and_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source_file=root/"source.png";mask_file=root/"mask.png"
            pixels=np.arange(12*12*3,dtype=np.uint8).reshape(12,12,3)
            Image.fromarray(pixels).save(source_file)
            mask=np.zeros((12,12),dtype=np.uint8);mask[3:8,3:8]=255;Image.fromarray(mask).save(mask_file)
            nodes=types.ModuleType(package.__name__+".nodes")
            nodes._parse_chat_image_reference=lambda ref:({},source_file if ref=="source" else mask_file)
            digest=hashlib.sha256(source_file.read_bytes()).hexdigest()
            source=torch.from_numpy(pixels.astype(np.float32)/255)[None]
            generated=torch.ones((1,24,24,4),dtype=torch.bfloat16)
            # Other suites install a lightweight torch stub. The compositor imports
            # torch lazily, so bind it to the same real module as these tensors.
            with patch.dict(sys.modules,{package.__name__:package,nodes.__name__:nodes,"torch":torch}):
                compositor=module.ReferenceRegionComposite()
                result=compositor.composite(generated,source,"mask","source",digest)[0]
                self.assertEqual(tuple(result.shape),tuple(source.shape))
                self.assertEqual(result.dtype,torch.float32)
                self.assertTrue(torch.equal(result[0][mask==0],source[0][mask==0]))
                self.assertTrue(bool((result[0][mask>0]==1).all()))
                batch=generated.repeat(2,1,1,1);batch[1,:,:,:3]=0
                results=compositor.composite(batch,source,"mask","source",digest)[0]
                self.assertEqual(tuple(results.shape),(2,12,12,3))
                self.assertTrue(torch.equal(results[1][mask==0],source[0][mask==0]))
                self.assertTrue(bool((results[1][mask>0]==0).all()))
                generated[:,:,:,3]=0
                self.assertTrue(torch.equal(compositor.composite(generated,source,"mask","source",digest)[0],source))
                Image.new("L",(4,4),255).save(mask_file)
                with self.assertRaisesRegex(ValueError,"dimensions"):compositor.composite(generated,source,"mask","source",digest)
                source_file.write_bytes(b"changed")
                with self.assertRaisesRegex(ValueError,"source file changed"):compositor.composite(generated,source,"mask","source",digest)

import copy
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "pose_mask_geometry_test"
package = types.ModuleType(PACKAGE); package.__path__ = [str(ROOT / "backend")]
def module(name):
    spec = importlib.util.spec_from_file_location(PACKAGE + "." + name, ROOT / "backend" / (name + ".py"))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result); return result
estimator, controlnet, qwen = module("pose_mask_estimate"), module("controlnet"), module("qwen_edit")


def pose():
    body = [(50,15),(50,26),(38,27),(32,43),(30,59),(62,27),(68,43),(70,59),
            (43,53),(42,72),(40,90),(57,53),(58,72),(60,90),(48,14),(52,14),(45,15),(55,15)]
    return {"canvas_width":100,"canvas_height":100,"people":[{"pose_keypoints_2d":[v for x,y in body for v in (x,y,1)]}]}


class PoseMaskEstimateTests(unittest.TestCase):
    def setUp(self):
        # Other suites install a lightweight torch stub; these exercise real tensors.
        self.enterContext(patch.dict(sys.modules, {"torch": torch}))

    def test_body_has_filled_torso_head_limbs_and_padding_grows_coverage(self):
        small = np.asarray(estimator.anatomy_mask(pose(),0))
        large = np.asarray(estimator.anatomy_mask(pose(),25))
        for x,y in ((50,40),(50,15),(32,43),(30,59),(40,92)):
            self.assertEqual(small[y,x],255)
        self.assertTrue(bool((large >= small).all()))
        self.assertGreater(int((large>0).sum()),int((small>0).sum()))
        self.assertEqual(large[0,0],0)

    def test_missing_and_invalid_joints_do_not_draw_at_origin(self):
        partial = pose();partial["people"][0]["pose_keypoints_2d"][12:15]=[0,0,0]
        self.assertEqual(np.asarray(estimator.anatomy_mask(partial))[0,0],0)
        with self.assertRaisesRegex(ValueError,"Too few"):
            estimator.anatomy_mask({**partial,"people":[{"pose_keypoints_2d":[0,0,0]*18}]})
        with self.assertRaises(ValueError): estimator.anatomy_mask(pose(),float("nan"))

    def test_union_keeps_original_and_target_and_uses_native_fit_placement(self):
        calls=[]
        def upscale(pixels,w,h,method,crop):
            calls.append((w,h,crop))
            return torch.nn.functional.interpolate(pixels,size=(h,w),mode="bilinear",align_corners=False)
        utils=types.SimpleNamespace(common_upscale=upscale)
        modules={PACKAGE:package,PACKAGE+".controlnet":controlnet,PACKAGE+".qwen_edit":qwen,
                 "comfy":types.SimpleNamespace(utils=utils),"comfy.utils":utils,"nodes":types.ModuleType("nodes")}
        target=pose(); target["people"][0]["pose_keypoints_2d"][9:15]=[18,27,1,2,27,1]
        with patch.dict(sys.modules,modules):
            image,mask=estimator.estimate(pose(),target,200,100,200,100,padding=0)
            self.assertEqual(tuple(image.shape),(1,100,200,3))
            self.assertGreater(float(mask[0,59,60]),.9) # Original wrist remains covered.
            self.assertGreater(float(mask[0,27,52]),.9) # Target wrist after centered fit.
            self.assertEqual(float(mask[0,0,0]),0)
            self.assertTrue(bool(((mask>0)&(mask<1)).any())) # Soft boundaries.
            estimator.estimate(pose(),target,200,100,200,100,targeting=json.dumps({"target":{"x":.5,"y":0,"width":.5,"height":1}}))
            self.assertIn((100,100,"disabled"),calls)
            many=copy.deepcopy(pose());many["people"]*=2
            with self.assertRaisesRegex(ValueError,"Several people"):
                estimator.estimate(many,target,200,100,200,100)
            estimator.estimate(many,target,200,100,200,100,all_people=True)


if __name__ == "__main__": unittest.main()

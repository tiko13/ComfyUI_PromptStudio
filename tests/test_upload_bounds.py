import asyncio
import tempfile
import unittest
from unittest import mock

class UploadBoundsTests(unittest.TestCase):
    def setUp(self):
        from test_regressions import load_modules
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        _,self.routes=load_modules(self.directory.name)

    def request(self,parts):
        class Field:
            headers={}
            def __init__(self,name,data):self.name=name;self.data=data
            async def read_chunk(self,size):
                self_chunk,self.data=self.data[:size],self.data[size:]
                return self_chunk
        class Reader:
            def __init__(self):self.parts=iter(Field(*part) for part in parts)
            async def next(self):return next(self.parts,None)
        class Request:
            content_length=None
            async def multipart(self):return Reader()
        return Request()

    def test_unknown_chunked_part_before_image_counts_against_aggregate_limit(self):
        with mock.patch.object(self.routes,'MAX_IMAGE_UPLOAD_REQUEST_BYTES',10):
            with self.assertRaisesRegex(ValueError,'aggregate'):
                asyncio.run(self.routes._read_uploaded_image(self.request([('unknown',b'x'*11),('image',b'ok')])))

    def test_small_unknown_fields_are_counted_and_maximum_part_count_is_bounded(self):
        self.assertEqual(asyncio.run(self.routes._read_uploaded_image(self.request([('unknown',b'x'),('image',b'ok')]))),b'ok')
        with self.assertRaisesRegex(ValueError,'too many'):
            asyncio.run(self.routes._read_uploaded_image(self.request([('unknown',b'')]*32+[('image',b'ok')])))

    def test_image_specific_limit_remains_in_force(self):
        with mock.patch.object(self.routes,'MAX_IMAGE_UPLOAD_BYTES',2):
            with self.assertRaisesRegex(ValueError,'20 MB'):
                asyncio.run(self.routes._read_uploaded_image(self.request([('image',b'xxx')])))

"""운영용 WSGI 서버에 연결할 application 진입점. HTTPS·영구 저장소 설정은 별도입니다."""
from server import initialize, application
initialize()

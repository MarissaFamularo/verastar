import './digestStatus.css'
import { renderDigestStatus } from './lib/digestStatus.js'

// Deliberately do not mount App, sign in, record engagement, or call a mutation.
// Refresh/Back only redisplays the outcome of the original signed request.
renderDigestStatus(document, window.location.search)

import { YouTubeExtractor } from './youtube-extractor';
import { JWPlayerExtractor } from './jwplayer-extractor';
export const EXTRACTORS = [
    new YouTubeExtractor(),
    new JWPlayerExtractor()
];

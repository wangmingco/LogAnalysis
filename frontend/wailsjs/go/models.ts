export namespace main {
	
	export class FileInfo {
	    name: string;
	    path: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new FileInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.size = source["size"];
	    }
	}
	export class FilterParams {
	    year: number;
	    startTime: string;
	    endTime: string;
	    keywords: string[];
	    level: string;
	
	    static createFrom(source: any = {}) {
	        return new FilterParams(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.year = source["year"];
	        this.startTime = source["startTime"];
	        this.endTime = source["endTime"];
	        this.keywords = source["keywords"];
	        this.level = source["level"];
	    }
	}
	export class FilterStats {
	    total: number;
	    filesLoaded: number;
	    totalBytes: number;
	    physicalLines: number;
	    foldedLines: number;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new FilterStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total = source["total"];
	        this.filesLoaded = source["filesLoaded"];
	        this.totalBytes = source["totalBytes"];
	        this.physicalLines = source["physicalLines"];
	        this.foldedLines = source["foldedLines"];
	        this.message = source["message"];
	    }
	}
	export class LogEntry {
	    lineNo: number;
	    time: string;
	    level: string;
	    logger: string;
	    thread: string;
	    msg: string;
	    unix: number;
	    hasTime: boolean;
	    text: string;
	    fileName: string;
	
	    static createFrom(source: any = {}) {
	        return new LogEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.lineNo = source["lineNo"];
	        this.time = source["time"];
	        this.level = source["level"];
	        this.logger = source["logger"];
	        this.thread = source["thread"];
	        this.msg = source["msg"];
	        this.unix = source["unix"];
	        this.hasTime = source["hasTime"];
	        this.text = source["text"];
	        this.fileName = source["fileName"];
	    }
	}
	export class TimeRange {
	    min: string;
	    max: string;
	
	    static createFrom(source: any = {}) {
	        return new TimeRange(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.min = source["min"];
	        this.max = source["max"];
	    }
	}

}


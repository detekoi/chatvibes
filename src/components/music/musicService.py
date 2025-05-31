# src/components/music/musicService.py
import replicate
import sys
import json
import os

def generate_music(prompt, negative_prompt=None, seed=None):
    try:
        # Initialize Replicate client
        replicate_client = replicate.Client(api_token=os.environ["REPLICATE_API_TOKEN"])
        
        # Prepare input data
        input_data = {"prompt": prompt}
        if negative_prompt:
            input_data["negative_prompt"] = negative_prompt
        if seed:
            input_data["seed"] = seed
        
        # Print progress for debugging
        print(json.dumps({"status": "starting", "prompt": prompt[:50]}), file=sys.stderr)
        sys.stderr.flush()
        
        # Run the model
        output = replicate_client.run(
            "google/lyria-2",
            input=input_data
        )
        
        print(json.dumps({"status": "processing", "message": "Model completed, processing output"}), file=sys.stderr)
        sys.stderr.flush()
        
        # Handle FileOutput vs URL string
        if hasattr(output, 'url'):
            # It's a FileOutput object - get the URL
            audio_url = output.url
        elif isinstance(output, str):
            # It's already a URL string
            audio_url = output
        else:
            # Unexpected output type
            raise Exception(f"Unexpected output type: {type(output)}")
        
        result = {
            "success": True,
            "audio_url": audio_url,
            "prompt": prompt
        }
        
        print(json.dumps({"status": "success", "message": "Returning result"}), file=sys.stderr)
        sys.stderr.flush()
        
        return result
        
    except Exception as e:
        error_msg = str(e)
        print(json.dumps({"status": "error", "error": error_msg}), file=sys.stderr)
        sys.stderr.flush()
        
        if "Prompt was rejected" in error_msg and "artist names" in error_msg:
            return {
                "success": False,
                "error": "artist_names_rejected",
                "message": "Prompt was rejected. Do not include artist names in the prompt."
            }
        return {
            "success": False,
            "error": "generation_failed",
            "message": f"Music generation failed: {error_msg}"
        }

if __name__ == "__main__":
    try:
        # Parse input arguments
        if len(sys.argv) < 2:
            raise Exception("No input arguments provided")
            
        input_data = json.loads(sys.argv[1])
        print(json.dumps({"status": "initialized", "input": input_data}), file=sys.stderr)
        sys.stderr.flush()
        
        # Generate music
        result = generate_music(**input_data)
        
        # Output result to stdout (this is what Node.js reads)
        print(json.dumps(result))
        sys.stdout.flush()  # Critical: flush stdout so Node.js receives the data
        
    except Exception as e:
        error_result = {
            "success": False,
            "error": "service_error",
            "message": str(e)
        }
        print(json.dumps(error_result))
        sys.stdout.flush()  # Critical: flush stdout
        
        # Also log to stderr for debugging
        print(json.dumps({"status": "fatal_error", "error": str(e)}), file=sys.stderr)
        sys.stderr.flush()